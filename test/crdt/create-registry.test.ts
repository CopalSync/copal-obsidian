import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createLocalNoteRegistry } from "../../src/crdt/create-registry";
import { InMemoryVault } from "../sync/fake-vault";

/** Only the one method the factory reads, standing in for the real `TokenStore`. */
const linkedTo = (vaultId: string | undefined) => ({
	getVaultId: () => vaultId,
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

		// One database per VAULT now (P2), so the vault id is the whole name rather than a key prefix.
		expect(await databaseNames()).toContain("copal:vlt-aaa");
		/*
		 * And not under the old shared tenant. Asserted explicitly, because the regression is a
		 * one-token edit that every other assertion in this file would survive: a store named
		 * `copal:vault` still persists, still reloads, still renames — while every Obsidian window
		 * shares it, which is the whole of N2.
		 */
		expect(await databaseNames()).not.toContain("copal:vault");
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

	it("follows a relink: after a wipe, the next vault's notes go to the next vault's database", async () => {
		// The shape `resetLocalVaultState` produces in `main.ts`: ONE registry, built in `onload`, wiped
		// while the old vault is still linked, then the folder relinked to a different vault (another
		// account's, after a sign-in) with no reload. The store used to memoise the first id it resolved,
		// so the wipe pinned the old vault and every note of the new one was persisted under it. A later
		// merge reconcile for the old vault then saw those notes as local and uploaded them into it.
		const link = { id: "vlt-relink-a" as string | undefined };
		const reg = createLocalNoteRegistry({ getVaultId: () => link.id }, new InMemoryVault({}));
		const before = reg.note("a.md");
		await before.whenLoaded;
		await reg.destroyAll();

		link.id = undefined; // unlinkVault
		link.id = "vlt-relink-b"; // setVault, then the adopt reconcile pulls the new vault's notes
		const pulled = reg.note("from-b.md");
		await pulled.whenLoaded;
		await pulled.note.applyFileEdit("account B's note");
		await reg.closeAll();

		expect(await databaseNames()).toContain("copal:vlt-relink-b");
		const oldVault = createLocalNoteRegistry(linkedTo("vlt-relink-a"), new InMemoryVault({}));
		expect(await oldVault.listPersisted(), "nothing of vault B may appear under vault A").toEqual(
			[],
		);
		const newVault = createLocalNoteRegistry(linkedTo("vlt-relink-b"), new InMemoryVault({}));
		expect(await newVault.listPersisted()).toEqual(["from-b.md"]);

		await oldVault.destroyAll();
		await newVault.destroyAll();
	});

	it("refuses to persist under a vault the folder is no longer linked to", async () => {
		// A relink without a wipe (an external `data.json` change from another device, say) must not
		// keep writing into the database that is open. Refusing is the `asVaultId` rule: persisting a
		// note under the wrong vault is worse than not persisting it at all.
		const link = { id: "vlt-swap-a" };
		const reg = createLocalNoteRegistry({ getVaultId: () => link.id }, new InMemoryVault({}));
		const opened = reg.note("open.md");
		await opened.whenLoaded;
		await opened.note.applyFileEdit("vault A's note");
		await new Promise((r) => setTimeout(r, 300)); // past the write-coalescing window

		link.id = "vlt-swap-b";
		await expect(reg.note("next.md").whenLoaded).rejects.toThrow(/linked vault changed/);
		const a = createLocalNoteRegistry(linkedTo("vlt-swap-a"), new InMemoryVault({}));
		expect(await a.listPersisted()).toEqual(["open.md"]);

		await a.closeAll();

		// Teardown still works on the database that is open, so a disconnect cannot be wedged by it.
		await reg.destroyAll();
		const afterWipe = createLocalNoteRegistry(linkedTo("vlt-swap-a"), new InMemoryVault({}));
		expect(await afterWipe.listPersisted()).toEqual([]);
		await afterWipe.destroyAll();
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
