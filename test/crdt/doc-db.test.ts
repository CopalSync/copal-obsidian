import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocDb, mergeRows } from "../../src/crdt/doc-db";

/**
 * P2's storage layer: one database per vault holding every note, replacing one database per note.
 */
let n = 0;
const freshDb = () => DocDb.open(`t${++n}`);

const updateFor = (text: string): Uint8Array => {
	const doc = new Y.Doc();
	doc.getText("content").insert(0, text);
	return Y.encodeStateAsUpdate(doc);
};
const textOf = (updates: Uint8Array[]): string => {
	const doc = new Y.Doc();
	for (const u of updates) Y.applyUpdate(doc, u);
	return doc.getText("content").toJSON();
};

beforeEach(() => {
	n += 1000; // a fresh database name per test; fake-indexeddb is module-global
});

describe("DocDb", () => {
	/**
	 * ⛔ The database name carries the vault id. A database called plain `copal` would be shared by two
	 * Obsidian folders linked to DIFFERENT Copal vaults — every window is the same `app://obsidian.md`
	 * origin — and stores keyed by note path would then collide exactly as N2 did: notes crossing
	 * accounts, same-path notes converging, one folder's disconnect destroying the other's history.
	 */
	it("names the database per vault, so two vaults cannot share one", async () => {
		const a = await DocDb.open("vlt_aaa");
		const b = await DocDb.open("vlt_bbb");
		expect(a.databaseName).toBe("copal:vlt_aaa");
		expect(b.databaseName).toBe("copal:vlt_bbb");

		await a.append("shared.md", updateFor("from A"));
		await b.append("shared.md", updateFor("from B"));

		expect(textOf((await a.load("shared.md")).updates)).toBe("from A");
		expect(textOf((await b.load("shared.md")).updates)).toBe("from B");
		a.close();
		b.close();
	});

	it("collapses every note into ONE database rather than one per note", async () => {
		const db = await freshDb();
		for (let i = 0; i < 40; i++) await db.append(`n${i}.md`, updateFor(`body ${i}`));

		const names = (await indexedDB.databases()).map((d) => d.name);
		expect(names.filter((x) => x?.startsWith(db.databaseName))).toEqual([db.databaseName]);
		// The old scheme would have produced one per note.
		expect(names.filter((x) => x?.includes("n39.md"))).toEqual([]);
		expect((await db.paths()).length).toBe(40);
		db.close();
	});

	it("round-trips a note's log and keeps rows/seq in step with it", async () => {
		const db = await freshDb();
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "one");
		await db.append("n.md", Y.encodeStateAsUpdate(doc));
		const before = Y.encodeStateVector(doc);
		doc.getText("content").insert(3, " two");
		await db.append("n.md", Y.encodeStateAsUpdate(doc, before));

		const loaded = await db.load("n.md");
		expect(loaded.record.rows).toBe(2);
		expect(loaded.record.seq).toBe(2);
		expect(textOf(loaded.updates)).toBe("one two");
		db.close();
	});

	it("compacts a log to one row without changing the text", async () => {
		const db = await freshDb();
		const doc = new Y.Doc();
		for (const word of ["a", "b", "c", "d"]) {
			const sv = Y.encodeStateVector(doc);
			doc.getText("content").insert(doc.getText("content").length, word);
			await db.append("n.md", Y.encodeStateAsUpdate(doc, sv));
		}
		expect((await db.load("n.md")).record.rows).toBe(4);

		const loaded = await db.load("n.md");
		await db.compact("n.md", mergeRows(loaded.updates));

		const after = await db.load("n.md");
		expect(after.record.rows).toBe(1);
		expect(textOf(after.updates)).toBe("abcd");
		db.close();
	});

	it("keeps a note's metadata across a compaction", async () => {
		const db = await freshDb();
		await db.append("n.md", updateFor("x"));
		await db.patch("n.md", { fileHash: "h1", serverSv: new ArrayBuffer(3), dirty: 1 });
		const loaded = await db.load("n.md");
		await db.compact("n.md", mergeRows(loaded.updates));

		const rec = await db.record("n.md");
		expect(rec.fileHash).toBe("h1");
		expect(rec.serverSv?.byteLength).toBe(3);
		expect(rec.dirty).toBe(1);
		db.close();
	});

	/**
	 * ⚠️ `dirty` is `0 | 1` and not a boolean because a boolean is NOT a valid IndexedDB key, and this
	 * field is indexed precisely so reconcile can find unpushed notes without loading every document.
	 */
	it("finds dirty notes through the index, without reading every record", async () => {
		const db = await freshDb();
		for (let i = 0; i < 20; i++) await db.append(`n${i}.md`, updateFor("x"));
		await db.patch("n3.md", { dirty: 1 });
		await db.patch("n7.md", { dirty: 1 });

		expect([...(await db.dirtyPaths())].sort()).toEqual(["n3.md", "n7.md"]);
		await db.patch("n3.md", { dirty: 0 });
		expect(await db.dirtyPaths()).toEqual(["n7.md"]);
		db.close();
	});

	it("persists the file hash, which is what makes evicting a doc safe", async () => {
		const db = await freshDb();
		await db.append("n.md", updateFor("body"));
		await db.patch("n.md", { fileHash: "deadbeef" });
		db.close();

		// A later session: the record survives, so a reopened note knows what is on disk and
		// `adoptUnseenFileEdits` cannot mistake the older file for an unseen edit.
		const again = await DocDb.open(db.databaseName.replace(/^copal:/, ""));
		expect((await again.record("n.md")).fileHash).toBe("deadbeef");
		again.close();
	});

	it("removes one note's log and record without touching its neighbours", async () => {
		const db = await freshDb();
		await db.append("keep.md", updateFor("keep"));
		await db.append("drop.md", updateFor("drop"));
		await db.remove("drop.md");

		expect(await db.paths()).toEqual(["keep.md"]);
		expect((await db.load("drop.md")).updates).toEqual([]);
		expect(textOf((await db.load("keep.md")).updates)).toBe("keep");
		db.close();
	});

	it("refuses to read after close, rather than silently doing nothing", async () => {
		const db = await freshDb();
		await db.append("n.md", updateFor("x"));
		db.close();
		await expect(db.paths()).rejects.toThrow(/closed/);
	});
});
