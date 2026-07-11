import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { LocalDocStore } from "../../src/crdt/local-doc-store";

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
    const s = new LocalDocStore("tr");
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
    await s.destroy("b.md");
  });

  it("persists a note's Y.Doc across store instances (survives a reload)", async () => {
    const s1 = new LocalDocStore("t1");
    const a = s1.open("a.md");
    await a.whenLoaded;
    a.doc.getText("content").insert(0, "hi");
    await new Promise((r) => setTimeout(r, 60)); // let the update flush to IndexedDB
    s1.close("a.md");

    // A fresh store (a "reload") rehydrates the same content — no server round-trip.
    const s2 = new LocalDocStore("t1");
    const b = s2.open("a.md");
    await b.whenLoaded;
    expect(b.doc.getText("content").toString()).toBe("hi");
    await s2.destroy("a.md");
  });

  it("lists persisted notes (so reconcile can skip them)", async () => {
    const s = new LocalDocStore("tp");
    const a = s.open("a.md");
    await a.whenLoaded;
    a.doc.getText("content").insert(0, "x");
    await new Promise((r) => setTimeout(r, 60)); // flush to idb
    const persisted = await s.listPersisted();
    expect(persisted).toContain("a.md");
    await s.destroy("a.md");
  });

  it("destroyAll() removes every persisted doc for the store (clean disconnect)", async () => {
    const s = new LocalDocStore("tall");
    for (const p of ["a.md", "dir/b.md", "c.md"]) {
      const e = s.open(p);
      // oxlint-disable-next-line no-await-in-loop
      await e.whenLoaded;
      e.doc.getText("content").insert(0, "x");
    }
    await new Promise((r) => setTimeout(r, 60)); // flush to idb
    expect((await s.listPersisted()).length).toBe(3);
    await s.destroyAll();
    expect(await s.listPersisted()).toEqual([]);
  });

  it("iOS (no indexedDB.databases): listPersisted() reads the maintained index", async () => {
    const s = new LocalDocStore("ios1");
    const a = s.open("a.md");
    const b = s.open("dir/b.md");
    await a.whenLoaded;
    await b.whenLoaded;
    await withoutDatabasesApi(async () => {
      // The serial index queue guarantees the open()-time adds run before this read — no flush wait needed.
      expect(new Set(await s.listPersisted())).toEqual(new Set(["a.md", "dir/b.md"]));
    });
    await s.destroyAll();
  });

  it("iOS: destroy + rename keep the index correct (no databases() fallback)", async () => {
    const s = new LocalDocStore("ios2");
    for (const p of ["a.md", "b.md"]) {
      const e = s.open(p);
      // oxlint-disable-next-line no-await-in-loop
      await e.whenLoaded;
    }
    await withoutDatabasesApi(async () => {
      await s.destroy("a.md");
      expect(await s.listPersisted()).toEqual(["b.md"]);
      await s.rename("b.md", "c.md");
      const after = await s.listPersisted();
      expect(after).toContain("c.md");
      expect(after).not.toContain("b.md");
    });
    await s.destroyAll();
  });

  it("desktop: heals the index from databases(), migrating a pre-index install", async () => {
    // A doc persisted BEFORE the index existed: create its y-indexeddb DB directly, leaving the index empty.
    const tenant = "mig1";
    const p = new IndexeddbPersistence(`copal:${tenant}:legacy.md`, new Y.Doc());
    await p.whenSynced;
    await p.destroy(); // close the connection but keep the DB on disk
    await new Promise((r) => setTimeout(r, 30));

    const s = new LocalDocStore(tenant);
    expect(await s.listPersisted()).toContain("legacy.md"); // found via databases() despite the empty index

    // …and the index was healed, so an iOS read now sees it too.
    await withoutDatabasesApi(async () => {
      expect(await s.listPersisted()).toContain("legacy.md");
    });
    await s.destroyAll();
  });

  it("returns the same live doc for repeated open() of one path", async () => {
    const s = new LocalDocStore("t1");
    const first = s.open("b.md");
    const second = s.open("b.md");
    expect(second.doc).toBe(first.doc);
    await s.destroy("b.md");
  });

  it("isolates tenants (same path, different tenant → different data)", async () => {
    const sa = new LocalDocStore("ta");
    const da = sa.open("n.md");
    await da.whenLoaded;
    da.doc.getText("content").insert(0, "alpha");
    await new Promise((r) => setTimeout(r, 60));
    sa.close("n.md");

    const sb = new LocalDocStore("tb");
    const db = sb.open("n.md");
    await db.whenLoaded;
    expect(db.doc.getText("content").toString()).toBe(""); // tenant tb never wrote n.md
    await sb.destroy("n.md");
    await new LocalDocStore("ta").destroy("n.md");
  });
});
