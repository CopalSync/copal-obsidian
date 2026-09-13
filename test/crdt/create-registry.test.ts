import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createLocalNoteRegistry } from "../../src/crdt/create-registry";
import { InMemoryVault } from "../sync/fake-vault";

/** Only the one method the factory reads, standing in for the real `TokenStore`. */
const linkedTo = (vaultId: string | undefined) => ({
	getVaultId: () => Promise.resolve(vaultId),
});

async function databaseNames(): Promise<string[]> {
	return ((await globalThis.indexedDB.databases()) ?? []).map((d) => d.name ?? "");
}

/**
 * ⛔ **THE TEST THAT WOULD HAVE CAUGHT F3.**
 *
 * `local-doc-store.test.ts` already proved the store keys databases by its tenant, and it passed
 * throughout the bug's life — because the bug was the ARGUMENT production passed, and the only file
 * that passed it had no tests. These cases drive the real wiring instead: a `TokenStore`, the factory,
 * and the database names that actually appear in IndexedDB.
 */
describe("createLocalNoteRegistry", () => {
	it("keys a note's database by the linked vault id", async () => {
		const reg = createLocalNoteRegistry(linkedTo("vlt-aaa"), new InMemoryVault({ "n.md": "hi" }));
		await reg.note("n.md").whenLoaded;

		expect(await databaseNames()).toContain("copal:vlt-aaa:n.md");
		/*
		 * And not under the old shared tenant. Asserted explicitly, because the regression is a
		 * one-token edit that every other assertion in this file would survive: a store keyed
		 * `copal:vault:n.md` still persists, still reloads, still renames.
		 */
		expect(await databaseNames()).not.toContain("copal:vault:n.md");
		await reg.destroy("n.md");
	});

	it("gives two vaults separate documents at the same path", async () => {
		const vault = new InMemoryVault({ "shared.md": "" });
		const a = createLocalNoteRegistry(linkedTo("vlt-one"), vault);
		const first = a.note("shared.md");
		await first.whenLoaded;
		await first.note.applyFileEdit("belongs to vault one");
		await new Promise((r) => setTimeout(r, 60)); // flush to idb
		a.close("shared.md");

		// A DIFFERENT Copal vault, same Obsidian origin, same note path. This is the exact shape of the
		// finding: under the shared tenant this read back vault one's text and then pushed it up.
		const b = createLocalNoteRegistry(linkedTo("vlt-two"), vault);
		const second = b.note("shared.md");
		await second.whenLoaded;
		expect(second.note.text()).toBe("");

		await a.destroy("shared.md");
		await b.destroy("shared.md");
	});

	it("persists nothing at all when the folder is not linked yet", async () => {
		const before = await databaseNames();
		const reg = createLocalNoteRegistry(linkedTo(undefined), new InMemoryVault({ "x.md": "hi" }));

		// The caller still gets a Y.Doc synchronously (editors bind to it before anything loads), but the
		// load fails rather than falling back to a default tenant — which is what the bug was.
		await expect(reg.note("x.md").whenLoaded).rejects.toThrow(/no linked Copal vault/);

		const after = await databaseNames();
		expect(after.filter((n) => n.startsWith("copal:"))).toEqual(
			before.filter((n) => n.startsWith("copal:")),
		);
	});
});
