import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { asVaultId, LocalDocStore } from "../../src/crdt/local-doc-store";
import { LocalNoteRegistry } from "../../src/crdt/local-note-registry";
import { InMemoryVault } from "../sync/fake-vault";

/**
 * P2's memory half. Docs used to accumulate forever: a first import of 10,000 notes left 10,000 Y.Docs
 * and their persistence resident, which is what made a large vault unusable on a phone.
 */
let n = 0;
const make = (max: number, files: Record<string, string> = {}) => {
	const vault = new InMemoryVault(files);
	// One id per store, resolved by every call: a provider names the vault linked NOW, which does not
	// change between two reads of it. (This used to mint a fresh id per CALL and passed only because the
	// store memoised the first answer, which was the relink bug.)
	const vaultId = asVaultId(`lru${++n}`);
	const store = new LocalDocStore(() => Promise.resolve(vaultId));
	return { registry: new LocalNoteRegistry(store, vault, max), store, vault };
};

describe("LocalNoteRegistry — bounded resident set", () => {
	it("keeps the resident set inside its bound while opening far more notes", async () => {
		const { registry } = make(8);
		for (let i = 0; i < 50; i++) {
			// oxlint-disable-next-line no-await-in-loop
			await registry.note(`n${i}.md`).whenLoaded;
		}
		expect(registry.residentCount()).toBeLessThanOrEqual(8);
	});

	it("evicts the least recently used, and keeps the one just touched", async () => {
		const { registry } = make(3);
		for (const p of ["a.md", "b.md", "c.md"]) await registry.note(p).whenLoaded;
		registry.note("a.md"); // touch a → b is now the oldest
		await registry.note("d.md").whenLoaded;

		expect(registry.get("b.md")).toBeUndefined();
		expect(registry.get("a.md")).toBeDefined();
		expect(registry.get("c.md")).toBeDefined();
		expect(registry.get("d.md")).toBeDefined();
	});

	/** ⛔ A pin is what stops an eviction pulling a doc out from under work in flight. */
	it("never evicts a pinned path, even when it is the least recently used", async () => {
		const { registry } = make(3);
		await registry.note("pinned.md").whenLoaded;
		const unpin = registry.acquire("pinned.md");
		for (const p of ["a.md", "b.md", "c.md", "d.md"]) await registry.note(p).whenLoaded;

		expect(registry.get("pinned.md"), "a pinned doc was evicted").toBeDefined();
		expect(registry.isPinned("pinned.md")).toBe(true);

		// Once released it becomes evictable like anything else.
		unpin();
		expect(registry.isPinned("pinned.md")).toBe(false);
		for (const p of ["e.md", "f.md", "g.md", "h.md"]) await registry.note(p).whenLoaded;
		expect(registry.get("pinned.md")).toBeUndefined();
	});

	/** A doc must not be evicted by its own creation, whatever order the caller pins in. */
	it("never evicts the path it was just asked for", async () => {
		const { registry } = make(2);
		for (const p of ["a.md", "b.md"]) await registry.note(p).whenLoaded;
		const fresh = registry.note("c.md");
		await fresh.whenLoaded;
		expect(registry.get("c.md"), "the newest doc was evicted by its own creation").toBeDefined();
		expect(registry.residentCount()).toBeLessThanOrEqual(2);
	});

	it("counts nested pins, so an inner release does not unpin an outer hold", async () => {
		const { registry } = make(2);
		await registry.note("hot.md").whenLoaded;
		const outer = registry.acquire("hot.md");
		const inner = registry.acquire("hot.md");
		inner();
		expect(registry.isPinned("hot.md")).toBe(true);
		outer();
		expect(registry.isPinned("hot.md")).toBe(false);
	});

	it("a double release is idempotent rather than unpinning somebody else's hold", async () => {
		const { registry } = make(2);
		await registry.note("hot.md").whenLoaded;
		const mine = registry.acquire("hot.md");
		const theirs = registry.acquire("hot.md");
		mine();
		mine(); // a buggy caller releasing twice must not drop `theirs`
		expect(registry.isPinned("hot.md")).toBe(true);
		theirs();
		expect(registry.isPinned("hot.md")).toBe(false);
	});

	it("exceeds the bound rather than evicting when everything resident is pinned", async () => {
		const { registry } = make(2);
		const held: Array<() => void> = [];
		for (const p of ["a.md", "b.md", "c.md", "d.md"]) {
			// Pin BEFORE opening, which is the order every production caller uses.
			held.push(registry.acquire(p));
			// oxlint-disable-next-line no-await-in-loop
			await registry.note(p).whenLoaded;
		}
		// Correct: the pins are held by work in flight. Evicting one would be the bug.
		expect(registry.residentCount()).toBe(4);
		for (const unpin of held) unpin();
		await registry.note("e.md").whenLoaded;
		expect(registry.residentCount()).toBeLessThanOrEqual(2);
	});

	/**
	 * ⛔ Eviction must cost a read, not a re-sync, and must not lose the note's knowledge of its `.md`.
	 * Without the persisted file hash a reopened note reports `fileStateUnknown()`, and the older file
	 * gets merged back over freshly-pulled content — which is why P1 could not release docs at all.
	 */
	it("an evicted note comes back with its content, file hash and server vector intact", async () => {
		const { registry, store } = make(2, { "keep.md": "on disk" });
		const first = registry.note("keep.md");
		await first.whenLoaded;
		first.note.doc.getText("content").insert(0, "persisted body");
		await store.flush("keep.md");
		first.note.setServerSv(new Uint8Array([1, 2, 3]));
		await first.note.materialize();
		const hashAfterWrite = first.note.fileStateUnknown();
		expect(hashAfterWrite).toBe(false);

		// Push it out of the resident set.
		for (const p of ["x.md", "y.md", "z.md"]) await registry.note(p).whenLoaded;
		expect(registry.get("keep.md")).toBeUndefined();

		const again = registry.note("keep.md");
		await again.whenLoaded;
		expect(again.note.text()).toBe("persisted body");
		expect(again.note.serverSv()).toEqual(new Uint8Array([1, 2, 3]));
		expect(again.note.fileStateUnknown(), "a reopened note forgot its .md").toBe(false);
		await registry.destroyAll();
	});
});
