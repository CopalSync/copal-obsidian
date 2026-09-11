import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { LocalDocStore } from "../../src/crdt/local-doc-store";
import { LocalNoteRegistry } from "../../src/crdt/local-note-registry";
import { InMemoryVault } from "../sync/fake-vault";

describe("LocalNoteRegistry", () => {
	it("returns a cached LocalNote per path and persists edits through the store", async () => {
		const store = new LocalDocStore("t1");
		const vault = new InMemoryVault({ "a.md": "hello" });
		const reg = new LocalNoteRegistry(store, vault);

		const first = reg.note("a.md");
		await first.whenLoaded;
		expect(reg.note("a.md").note).toBe(first.note); // cached

		await first.note.applyFileEdit("hello!");
		expect(first.note.text()).toBe("hello!");
		await new Promise((r) => setTimeout(r, 60)); // flush to idb
		reg.close("a.md");

		// A fresh registry (reload) rehydrates the note from persistence.
		const reg2 = new LocalNoteRegistry(new LocalDocStore("t1"), vault);
		const again = reg2.note("a.md");
		await again.whenLoaded;
		expect(again.note.text()).toBe("hello!");
		await reg2.destroy("a.md");
	});

	it("rename moves the note's lineage old→new and drops the stale cached LocalNote", async () => {
		const store = new LocalDocStore("tr2");
		const vault = new InMemoryVault({ "old.md": "content" });
		const reg = new LocalNoteRegistry(store, vault);
		const old = reg.note("old.md");
		await old.whenLoaded;
		await old.note.applyFileEdit("content");

		await reg.rename("old.md", "new.md");

		expect(reg.get("old.md")).toBeUndefined(); // stale cached note dropped
		const renamed = reg.note("new.md");
		await renamed.whenLoaded;
		expect(renamed.note.text()).toBe("content"); // lineage carried to the new path
		expect(await store.listPersisted()).not.toContain("old.md");
		await reg.destroy("new.md");
	});
});
