import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { LocalNote } from "../../src/crdt/local-note";
import { contentHash } from "../../src/sync/hash";
import { InMemoryVault } from "../sync/fake-vault";

describe("LocalNote", () => {
	it("applies an external file edit as a minimal op on the doc's shared history", async () => {
		// A doc with prior history, and a peer that already shares that history.
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "hello world");
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc)); // peer now shares the history

		const vault = new InMemoryVault({ "n.md": "hello brave world" });
		const note = new LocalNote(doc, "n.md", vault);
		await note.applyFileEdit("hello brave world");

		expect(note.text()).toBe("hello brave world");
		// The edit must be an OP (an insert of "brave "), not a replace: applying doc's new updates to the
		// peer that shared the old history converges — proving shared history is intact.
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
		expect(peer.getText("content").toString()).toBe("hello brave world");
	});

	it("tags external edits with origin 'file'", async () => {
		const doc = new Y.Doc();
		const origins: unknown[] = [];
		doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
		const note = new LocalNote(doc, "n.md", new InMemoryVault({ "n.md": "x" }));
		await note.applyFileEdit("x");
		expect(origins).toEqual(["file"]);
	});

	it("materializes the doc to the file, and its own echo is a no-op (no loop)", async () => {
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "from the agent");
		const vault = new InMemoryVault();
		const write = vi.spyOn(vault, "write");
		const note = new LocalNote(doc, "n.md", vault);

		await note.materialize();
		expect(vault.snapshot()["n.md"]).toBe("from the agent");
		expect(write).toHaveBeenCalledTimes(1);

		// The file-watcher echo of that same content must NOT re-apply or re-write (hash guard).
		await note.applyFileEdit("from the agent");
		await note.materialize();
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("is a no-op materialize when the file already matches the doc", async () => {
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "same");
		const vault = new InMemoryVault();
		const note = new LocalNote(doc, "n.md", vault);
		await note.applyFileEdit("same"); // sets the guard hash to the current content
		const write = vi.spyOn(vault, "write");
		await note.materialize();
		expect(write).not.toHaveBeenCalled();
		void (await contentHash("same"));
	});
});
