import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { asVaultId, LocalDocStore } from "../../src/crdt/local-doc-store";

/** A fixed vault id, supplied the way the production factory supplies one. */
const vaultIdOf = (id: string) => () => Promise.resolve(asVaultId(id));

type DbEnum = { databases?: (() => Promise<IDBDatabaseInfo[]>) | undefined };

/** Simulate iOS/WebKit, where `indexedDB.databases()` is not implemented, for the duration of `fn`. */
async function withoutDatabasesApi(fn: () => Promise<void>): Promise<void> {
	const idb = globalThis.indexedDB as unknown as DbEnum;
	const orig = idb.databases;
	idb.databases = undefined;
	try {
		await fn();
	} finally {
		idb.databases = orig;
	}
}

describe("LocalDocStore", () => {
	it("rename transfers a note's persisted doc LINEAGE old→new (same state vector), destroying the old", async () => {
		const s = new LocalDocStore(vaultIdOf("tr"));
		const a = s.open("a.md");
		await a.whenLoaded;
		a.doc.getText("content").insert(0, "shared history");
		const svBefore = Array.from(Y.encodeStateVector(a.doc)); // the exact struct clocks (client IDs)

		await s.rename("a.md", "b.md");

		const b = s.open("b.md");
		await b.whenLoaded;
		expect(b.doc.getText("content").toString()).toBe("shared history"); // content preserved
		expect(Array.from(Y.encodeStateVector(b.doc))).toEqual(svBefore); // SAME lineage, not a fresh doc
		expect(await s.listPersisted()).not.toContain("a.md"); // old persisted doc destroyed
		await s.closeAll();
	});

	it("persists a note's Y.Doc across store instances (survives a reload)", async () => {
		const s1 = new LocalDocStore(vaultIdOf("t1"));
		const a = s1.open("a.md");
		await a.whenLoaded;
		a.doc.getText("content").insert(0, "hi");
		await s1.flush("a.md"); // explicit, rather than sleeping past the coalescing window
		await s1.closeAll();

		// A fresh store (a "reload") rehydrates the same content — no server round-trip.
		const s2 = new LocalDocStore(vaultIdOf("t1"));
		const b = s2.open("a.md");
		await b.whenLoaded;
		expect(b.doc.getText("content").toString()).toBe("hi");
		await s2.destroyAll();
	});

	it("lists persisted notes (so reconcile can skip them)", async () => {
		const s = new LocalDocStore(vaultIdOf("tp"));
		const a = s.open("a.md");
		await a.whenLoaded;
		a.doc.getText("content").insert(0, "x");
		await s.flush("a.md");
		expect(await s.listPersisted()).toContain("a.md");
		await s.destroyAll();
	});

	it("destroyAll() removes every persisted doc for the store (clean disconnect)", async () => {
		const s = new LocalDocStore(vaultIdOf("tall"));
		for (const p of ["a.md", "dir/b.md", "c.md"]) {
			const e = s.open(p);
			// oxlint-disable-next-line no-await-in-loop
			await e.whenLoaded;
			e.doc.getText("content").insert(0, "x");
		}
		await s.flushAll();
		expect((await s.listPersisted()).length).toBe(3);
		await s.destroyAll();
		expect(await s.listPersisted()).toEqual([]);
	});

	/**
	 * ⚠️ iOS/WebKit has never implemented `indexedDB.databases()`. The old one-database-per-note scheme
	 * needed a second database (`copal-index`) purely to list notes there, and the two paths could drift.
	 * One database per vault makes listing a `getAllKeys`, so desktop and iOS now run the same code — this
	 * asserts the read path never reaches for `databases()` at all.
	 */
	it("lists and mutates notes on iOS, where databases() does not exist", async () => {
		const s = new LocalDocStore(vaultIdOf("ios1"));
		for (const p of ["a.md", "dir/b.md"]) {
			const e = s.open(p);
			// oxlint-disable-next-line no-await-in-loop
			await e.whenLoaded;
			e.doc.getText("content").insert(0, "x");
		}
		await s.flushAll();
		await withoutDatabasesApi(async () => {
			expect(new Set(await s.listPersisted())).toEqual(new Set(["a.md", "dir/b.md"]));
			await s.destroy("a.md");
			expect(await s.listPersisted()).toEqual(["dir/b.md"]);
			await s.rename("dir/b.md", "c.md");
			const after = await s.listPersisted();
			expect(after).toContain("c.md");
			expect(after).not.toContain("dir/b.md");
		});
		await s.destroyAll();
	});

	/**
	 * The importer that retires the per-note scheme. Built with the REAL y-indexeddb writer rather than a
	 * hand-made imitation of its shape, because the thing being tested is whether we can read what it
	 * actually wrote — a fixture matching my guess at the format would prove nothing.
	 */
	it("imports a legacy per-note database, then deletes it", async () => {
		const tenant = "mig1";
		const legacyName = `copal:${tenant}:legacy.md`;
		const legacyDoc = new Y.Doc();
		const p = new IndexeddbPersistence(legacyName, legacyDoc);
		await p.whenSynced;
		legacyDoc.getText("content").insert(0, "written by the old scheme");
		await new Promise((r) => setTimeout(r, 50)); // y-indexeddb writes on its own schedule
		await p.destroy();

		const s = new LocalDocStore(vaultIdOf(tenant));
		expect(await s.listPersisted()).toContain("legacy.md");
		const opened = s.open("legacy.md");
		await opened.whenLoaded;
		expect(opened.doc.getText("content").toString()).toBe("written by the old scheme");

		// An importer that removes its inputs, so it cannot run twice or leave the old data behind.
		const names = (await indexedDB.databases()).map((d) => d.name);
		expect(names).not.toContain(legacyName);
		// Imported notes are marked dirty: the server may never have seen them.
		expect(await s.listDirty()).toContain("legacy.md");
		await s.destroyAll();
	});

	it("returns the same live doc for repeated open() of one path", async () => {
		const s = new LocalDocStore(vaultIdOf("tsame"));
		const first = s.open("b.md");
		const second = s.open("b.md");
		expect(second.doc).toBe(first.doc);
		await s.closeAll();
	});

	it("isolates vaults (same path, different vault → different data)", async () => {
		const sa = new LocalDocStore(vaultIdOf("ta"));
		const da = sa.open("n.md");
		await da.whenLoaded;
		da.doc.getText("content").insert(0, "alpha");
		await sa.flush("n.md");
		await sa.closeAll();

		const sb = new LocalDocStore(vaultIdOf("tb"));
		const db = sb.open("n.md");
		await db.whenLoaded;
		expect(db.doc.getText("content").toString()).toBe(""); // vault tb never wrote n.md
		await sb.destroyAll();
		await new LocalDocStore(vaultIdOf("ta")).destroyAll();
	});

	/** A burst of keystrokes must be one transaction, not one per character. */
	it("coalesces a burst of updates into a single row", async () => {
		const s = new LocalDocStore(vaultIdOf("tcoal"));
		const a = s.open("n.md");
		await a.whenLoaded;
		for (let i = 0; i < 50; i++) a.doc.getText("content").insert(i, "x");
		await s.flush("n.md");

		expect((await s.record("n.md")).rows).toBeLessThanOrEqual(2);
		expect(a.doc.getText("content").toString()).toHaveLength(50);
		await s.destroyAll();
	});

	it("compacts a long log on close, so the next open is one row", async () => {
		const s = new LocalDocStore(vaultIdOf("tcomp"));
		const a = s.open("n.md");
		await a.whenLoaded;
		// 60 separate flushed writes, past the close-time compaction threshold of 50.
		for (let i = 0; i < 60; i++) {
			a.doc.getText("content").insert(0, "y");
			// oxlint-disable-next-line no-await-in-loop -- one row per write is the point here
			await s.flush("n.md");
		}
		expect((await s.record("n.md")).rows).toBe(60);

		s.close("n.md");
		await s.closeAll();

		const again = new LocalDocStore(vaultIdOf("tcomp"));
		expect((await again.record("n.md")).rows).toBe(1);
		const reopened = again.open("n.md");
		await reopened.whenLoaded;
		expect(reopened.doc.getText("content").toString()).toHaveLength(60);
		await again.destroyAll();
	});

	/**
	 * ⛔ The record that makes eviction safe. `LocalNote.lastHash` was in-memory only, so a closed and
	 * reopened note reported `fileStateUnknown()` and `adoptUnseenFileEdits` merged the older `.md` back
	 * over freshly-pulled content. P1 had to abandon its per-page doc release for exactly that.
	 */
	it("persists the server state vector and the file hash across a close", async () => {
		const s = new LocalDocStore(vaultIdOf("tmeta"));
		const a = s.open("n.md");
		await a.whenLoaded;
		a.doc.getText("content").insert(0, "body");
		await s.flush("n.md");
		await s.setMeta("n.md", { serverSv: new Uint8Array([1, 2, 3]), fileHash: "abc", dirty: false });
		await s.closeAll();

		const again = new LocalDocStore(vaultIdOf("tmeta"));
		const rec = await again.record("n.md");
		expect(new Uint8Array(rec.serverSv ?? new ArrayBuffer(0))).toEqual(new Uint8Array([1, 2, 3]));
		expect(rec.fileHash).toBe("abc");
		expect(rec.dirty).toBe(0);
		expect(await again.listDirty()).not.toContain("n.md");
		await again.destroyAll();
	});

	it("marks a locally edited note dirty, and a server-applied one not", async () => {
		const s = new LocalDocStore(vaultIdOf("tdirty"));
		const local = s.open("local.md");
		const remote = s.open("remote.md");
		await Promise.all([local.whenLoaded, remote.whenLoaded]);

		local.doc.getText("content").insert(0, "mine");
		remote.doc.transact(() => remote.doc.getText("content").insert(0, "theirs"), "server");
		await s.flushAll();

		expect(await s.listDirty()).toEqual(["local.md"]);
		await s.destroyAll();
	});
});
