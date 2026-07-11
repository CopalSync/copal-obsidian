import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CrdtNote, type YTransport } from "../../src/crdt/crdt-note";
import { CrdtSync, type CrdtSyncDeps } from "../../src/crdt/crdt-sync";
import { LocalDocStore } from "../../src/crdt/local-doc-store";
import { LocalNoteRegistry } from "../../src/crdt/local-note-registry";
import type { SyncApi } from "../../src/sync/api";
import { type MutationData, MutationQueue } from "../../src/sync/mutation-queue";
import { InMemoryVault } from "../sync/fake-vault";

/** A MutationQueue backed by an in-memory `data.json` record (mirrors the real `pending`-key persistence). */
function makeQueue(initial: MutationData | null = null) {
  let data = initial;
  const q = new MutationQueue(
    () => Promise.resolve(data),
    (d) => {
      data = d;
      return Promise.resolve();
    },
  );
  return { q, peek: () => data };
}

/**
 * Two in-memory transports that deliver each other's sends asynchronously (a fake network). Messages for
 * a receiver that hasn't attached yet are buffered + flushed on attach — so a peer created before its
 * counterpart's `onMessage` (like the server here) doesn't lose its initial syncStep1.
 */
function pairedTransports(): { a: YTransport; b: YTransport } {
  const s: {
    aRecv?: (d: ArrayBuffer) => void;
    bRecv?: (d: ArrayBuffer) => void;
    aBuf: ArrayBuffer[];
    bBuf: ArrayBuffer[];
  } = { aBuf: [], bBuf: [] };
  const a: YTransport = {
    send: (d) => queueMicrotask(() => (s.bRecv ? s.bRecv(d) : s.bBuf.push(d))),
    onMessage: (cb) => {
      s.aRecv = cb as (d: ArrayBuffer) => void;
      for (const d of s.aBuf.splice(0)) queueMicrotask(() => s.aRecv?.(d));
    },
    onOpen: (cb) => cb(),
    close: () => undefined,
  };
  const b: YTransport = {
    send: (d) => queueMicrotask(() => (s.aRecv ? s.aRecv(d) : s.aBuf.push(d))),
    onMessage: (cb) => {
      s.bRecv = cb as (d: ArrayBuffer) => void;
      for (const d of s.bBuf.splice(0)) queueMicrotask(() => s.bRecv?.(d));
    },
    onOpen: (cb) => cb(),
    close: () => undefined,
  };
  return { a, b };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let tenantN = 0;

/**
 * A CrdtSync wired to real persistence (fake-indexeddb) + a fake network. The "server" is a persistent
 * Y.Doc per path (like the DO); every transient connect creates a fresh server peer wrapping it.
 */
function makeSync(
  vaultFiles: Record<string, string>,
  extra: Partial<CrdtSyncDeps> = {},
  opts: {
    deleteNote?: (p: string) => Promise<void>;
    moveNote?: (from: string, to: string) => Promise<void>;
  } = {},
) {
  const store = new LocalDocStore(`t${++tenantN}`);
  const vault = new InMemoryVault(vaultFiles);
  const registry = new LocalNoteRegistry(store, vault);
  const serverDocs = new Map<string, Y.Doc>();
  const transportFor = (path: string): Promise<YTransport> => {
    const { a, b } = pairedTransports();
    let serverDoc = serverDocs.get(path);
    if (!serverDoc) {
      serverDoc = new Y.Doc();
      serverDocs.set(path, serverDoc);
    }
    new CrdtNote(b, serverDoc); // a fresh server peer wrapping the persistent server doc
    return Promise.resolve(a);
  };
  const bound: CrdtNote[] = [];
  const deleted: string[] = [];
  const moved: [string, string][] = [];
  // A mutable server manifest the fake `api.manifest()` reads at reconcile time (paths + journal head).
  const manifestState: { head: number; entries: { path: string }[] } = { head: 0, entries: [] };
  const defaultDelete = (p: string): Promise<void> => {
    deleted.push(p);
    return Promise.resolve();
  };
  // Simulate the server-side move: the source note DO (with its history) becomes the destination DO, so a
  // rekeyed local doc connecting to `to` converges with the moved history (identical state vectors).
  const defaultMove = (from: string, to: string): Promise<void> => {
    const d = serverDocs.get(from);
    if (d) {
      serverDocs.set(to, d);
      serverDocs.delete(from);
    }
    moved.push([from, to]);
    return Promise.resolve();
  };
  const crdt = new CrdtSync({
    api: {
      manifest: () =>
        Promise.resolve({ head: manifestState.head, manifest: manifestState.entries }),
      deleteNote: opts.deleteNote ?? defaultDelete,
      moveNote: opts.moveNote ?? defaultMove,
    } as unknown as SyncApi,
    registry,
    vault,
    transportFor,
    settleMs: 0,
    bind: (peer) => bound.push(peer),
    ...extra,
  });
  return { crdt, registry, vault, serverDocs, bound, deleted, moved, manifestState };
}
const serverText = (docs: Map<string, Y.Doc>, path: string) =>
  docs.get(path)?.getText("content").toString() ?? "";

describe("CrdtSync (local-first op-sync)", () => {
  it("onLocalChange applies a file edit as an op and syncs it up to the server", async () => {
    const { crdt, serverDocs } = makeSync({ "n.md": "hello world" });
    await crdt.onLocalChange("n.md", "hello world");
    await waitFor(() => serverText(serverDocs, "n.md") === "hello world");
    expect(serverText(serverDocs, "n.md")).toBe("hello world");
  });

  it("onRemoteChange syncs remote ops into the local doc + materializes the .md", async () => {
    const { crdt, serverDocs, vault } = makeSync({});
    const serverDoc = new Y.Doc();
    serverDoc.getText("content").insert(0, "from agent");
    serverDocs.set("x.md", serverDoc);
    await crdt.onRemoteChange({ path: "x.md", op: "put" });
    await waitFor(() => vault.snapshot()["x.md"] === "from agent");
    expect(vault.snapshot()["x.md"]).toBe("from agent");
  });

  it("quarantines a non-markdown remote change — never CRDT-pulls a binary path as text", async () => {
    const { crdt, serverDocs, vault } = makeSync({});
    const serverDoc = new Y.Doc();
    serverDoc.getText("content").insert(0, "binary");
    serverDocs.set("image.png", serverDoc);
    await crdt.onRemoteChange({ path: "image.png", op: "put" });
    // The text CRDT engine is markdown-only: a binary journal entry is skipped, never materialized.
    expect(vault.snapshot()["image.png"]).toBeUndefined();
  });

  it("reconcile pulls only markdown manifest entries (binaries quarantined)", async () => {
    const { crdt, serverDocs, vault, manifestState } = makeSync({});
    const md = new Y.Doc();
    md.getText("content").insert(0, "note body");
    serverDocs.set("note.md", md);
    const png = new Y.Doc();
    png.getText("content").insert(0, "binary");
    serverDocs.set("pic.png", png);
    manifestState.entries = [{ path: "note.md" }, { path: "pic.png" }];
    await crdt.reconcile([], "merge");
    await waitFor(() => vault.snapshot()["note.md"] === "note body");
    expect(vault.snapshot()["note.md"]).toBe("note body"); // .md pulled
    expect(vault.snapshot()["pic.png"]).toBeUndefined(); // binary quarantined
  });

  it("UNIONS an offline local edit with a concurrent server edit — zero loss", async () => {
    const { crdt, serverDocs, registry } = makeSync({ "n.md": "" });
    await crdt.onLocalChange("n.md", "BASE\n"); // establish shared history
    await waitFor(() => serverText(serverDocs, "n.md") === "BASE\n");

    // Both diverge OFFLINE (no connection between the two edits).
    const { note } = registry.note("n.md");
    note.doc.getText("content").insert(note.text().length, "LOCAL\n");
    const sd = serverDocs.get("n.md")!;
    sd.getText("content").insert(sd.getText("content").length, "SERVER\n");

    await crdt.onRemoteChange({ path: "n.md", op: "put" }); // reconnect + sync
    await waitFor(() => note.text().includes("LOCAL") && note.text().includes("SERVER"));
    expect(note.text()).toContain("BASE");
    expect(note.text()).toContain("LOCAL");
    expect(note.text()).toContain("SERVER"); // nothing lost
  });

  it("does NOT duplicate an existing note (server + local file already share the same text)", async () => {
    const { crdt, serverDocs, registry, vault } = makeSync({ "n.md": "existing content" });
    const sd = new Y.Doc();
    sd.getText("content").insert(0, "existing content"); // the server already has this note
    serverDocs.set("n.md", sd);
    // Sync-first must ADOPT the server content, not seed the file into an empty doc + union (= duplicate).
    await crdt.onRemoteChange({ path: "n.md", op: "put" });
    const { note } = registry.note("n.md");
    await waitFor(() => note.text() === "existing content");
    expect(note.text()).toBe("existing content"); // exactly once — not doubled
    expect(vault.snapshot()["n.md"]).toBe("existing content");
  });

  it("first-import divergence keeps a labelled conflict copy — nothing lost", async () => {
    const { crdt, serverDocs, vault } = makeSync({ "n.md": "LOCAL VERSION" });
    const sd = new Y.Doc();
    sd.getText("content").insert(0, "SERVER VERSION"); // server + local diverged, no shared history
    serverDocs.set("n.md", sd);
    await crdt.onRemoteChange({ path: "n.md", op: "put" });
    await waitFor(() => vault.snapshot()["n.md"] === "SERVER VERSION");
    expect(vault.snapshot()["n.md"]).toBe("SERVER VERSION"); // adopts server
    expect(vault.snapshot()["n (conflicted copy).md"]).toBe("LOCAL VERSION"); // local text preserved
  });

  it("deleteLocal propagates the delete remotely and drops the persisted doc", async () => {
    const { crdt, registry, deleted } = makeSync({ "d.md": "x" });
    registry.note("d.md");
    await crdt.deleteLocal("d.md");
    expect(deleted).toEqual(["d.md"]); // DELETE /vault propagated (R2 + DO teardown + journal)
    expect(registry.get("d.md")).toBeUndefined(); // local doc dropped
  });

  it("deleteLocal KEEPS the persisted doc + surfaces the error when the server delete fails", async () => {
    // A failed server delete must NOT orphan the note (server keeps it / local forgets it → resurrect).
    // Keep the persisted doc and throw so main.ts can surface it; reconcile retries once the server lands.
    const { crdt, registry } = makeSync({ "d.md": "x" }, {}, {
      deleteNote: () => Promise.reject(new Error("delete failed: 500")),
    });
    const { note, whenLoaded } = registry.note("d.md");
    await whenLoaded;
    await note.applyFileEdit("x"); // give it a persisted local doc
    await waitFor(async () => (await registry.listPersisted()).includes("d.md"));

    await expect(crdt.deleteLocal("d.md")).rejects.toThrow(/delete failed/); // failure surfaced

    expect(await registry.listPersisted()).toContain("d.md"); // doc KEPT — not orphaned
    expect(registry.get("d.md")).toBeDefined();
  });

  it("rename preserves history: server move + local lineage transfer, rebinds the editor to the new path", async () => {
    // The active note is renamed. Instead of delete+recreate (which resets the Y.Doc), rename MOVES the note
    // server-side AND transfers the local persisted doc lineage old→new, so the note keeps its CRDT history.
    const { crdt, registry, vault, serverDocs, bound, moved } = makeSync({ "old.md": "hello" });
    await crdt.open("old.md");
    await waitFor(() => crdt.ownsPath("old.md") && bound.length === 1);
    await waitFor(() => serverText(serverDocs, "old.md") === "hello");
    const oldSv = Array.from(Y.encodeStateVector(registry.note("old.md").note.doc)); // the note's lineage

    // Obsidian has already moved the file on disk by the time the rename event fires.
    await vault.write("new.md", "hello");
    await vault.remove("old.md");

    await crdt.rename("old.md", "new.md");

    expect(moved).toEqual([["old.md", "new.md"]]); // server-side move (transfers the CRDT log + R2 + tombstone)
    expect(crdt.ownsPath("old.md")).toBe(false);
    expect(crdt.ownsPath("new.md")).toBe(true); // the live socket + editor moved to the new path
    expect(registry.get("old.md")).toBeUndefined(); // old local doc gone (lineage moved, not orphaned)

    await waitFor(() => bound.length === 2);
    const newDoc = registry.note("new.md").note.doc;
    expect(newDoc.getText("content").toString()).toBe("hello"); // content preserved
    expect(Array.from(Y.encodeStateVector(newDoc))).toEqual(oldSv); // SAME lineage — history preserved, not a fresh doc
    await crdt.close();
  });

  it("rename falls back to delete-old + upload-new when the server move fails", async () => {
    const { crdt, vault, serverDocs, deleted } = makeSync({ "old.md": "hello" }, {}, {
      moveNote: () => Promise.reject(new Error("move failed: 503")),
    });
    await crdt.open("old.md");
    await waitFor(() => crdt.ownsPath("old.md"));
    await waitFor(() => serverText(serverDocs, "old.md") === "hello");
    await vault.write("new.md", "hello");
    await vault.remove("old.md");

    await crdt.rename("old.md", "new.md");

    expect(deleted).toContain("old.md"); // fell back to deleting the old path
    expect(crdt.ownsPath("new.md")).toBe(true); // editor still followed to the new path
    await waitFor(() => serverText(serverDocs, "new.md") === "hello"); // new content uploaded (bring-existing)
    await crdt.close();
  });

  it("a fully-offline rename durably queues the old-path delete and keeps the old doc (no resurrect)", async () => {
    const { q } = makeQueue();
    await q.init();
    const { crdt, registry, vault } = makeSync({ "old.md": "hello" }, { queue: q }, {
      moveNote: () => Promise.reject(new Error("offline")),
      deleteNote: () => Promise.reject(new Error("offline")),
    });
    await crdt.open("old.md");
    await waitFor(() => crdt.ownsPath("old.md"));
    await vault.write("new.md", "hello");
    await vault.remove("old.md");

    await crdt.rename("old.md", "new.md");

    expect(q.list()).toContain("old.md"); // delete durably queued for retry on reconnect
    expect(registry.get("old.md")).toBeDefined(); // old doc kept (no orphan → no resurrection)
    expect(crdt.ownsPath("new.md")).toBe(true); // editor still followed to the new path
    await crdt.close();
  });

  it("onRemoteChange delete removes the local file (→ trash) and drops the persisted doc", async () => {
    const { crdt, registry, vault } = makeSync({ "gone.md": "bye" });
    registry.note("gone.md"); // it has a persisted local doc
    await crdt.onRemoteChange({ path: "gone.md", op: "delete" });
    expect(await vault.exists("gone.md")).toBe(false); // removed from the vault (trashed in real Obsidian)
    expect(registry.get("gone.md")).toBeUndefined(); // persisted doc dropped
  });

  it("open connects the active note, seeds it from the file, and binds after sync", async () => {
    const { crdt, bound } = makeSync({ "a.md": "hi from file" });
    await crdt.open("a.md");
    await waitFor(() => bound.length === 1);
    expect(bound[0]!.text()).toBe("hi from file");
    await crdt.close();
  });

  it("reconcile pushes local-only notes up to an empty server (bring-existing first-import)", async () => {
    // Two notes have persisted local docs (seeded from their files) but were never pushed; the server is
    // empty (manifest []). A fresh connect must upload the whole local vault, not sit idle.
    const { crdt, registry, serverDocs } = makeSync({ "a.md": "note A", "b.md": "note B" });
    for (const [path, text] of [
      ["a.md", "note A"],
      ["b.md", "note B"],
    ] as const) {
      const { note, whenLoaded } = registry.note(path);
      await whenLoaded;
      await note.applyFileEdit(text); // an op on the persisted local doc
    }
    await waitFor(async () => (await registry.listPersisted()).length === 2);

    await crdt.reconcile();

    await waitFor(
      () => serverText(serverDocs, "a.md") === "note A" && serverText(serverDocs, "b.md") === "note B",
    );
    expect(serverText(serverDocs, "a.md")).toBe("note A");
    expect(serverText(serverDocs, "b.md")).toBe("note B");
  });

  it("reconcile seeds + pushes a never-opened local file (no persisted doc) — full bring-existing", async () => {
    // "c.md" exists in the vault but was never opened, so it has NO persisted local Y.Doc. reconcile must
    // still scan the vault, seed a doc from the file, and push it (not just process already-persisted docs).
    const { crdt, registry, serverDocs } = makeSync({ "c.md": "never opened" });
    expect(await registry.listPersisted()).not.toContain("c.md"); // precondition: no persisted doc

    await crdt.reconcile();

    await waitFor(() => serverText(serverDocs, "c.md") === "never opened");
    expect(serverText(serverDocs, "c.md")).toBe("never opened");
  });

  // ── Tombstone-aware reconcile: a local note absent from the server is NEW if never known (push), or a
  //    remote DELETE if it was known (remove locally) — instead of blindly re-pushing (resurrecting) it.

  it("T1: removes a known-but-server-deleted note locally — no resurrection", async () => {
    const { crdt, registry, vault, serverDocs, deleted } = makeSync({ "x.md": "content x" });
    const { note, whenLoaded } = registry.note("x.md");
    await whenLoaded;
    await note.applyFileEdit("content x"); // it has a persisted local doc (was synced before)
    await waitFor(async () => (await registry.listPersisted()).includes("x.md"));

    // Server manifest is empty (x.md was deleted there); known says x.md WAS on the server.
    const cursor = await crdt.reconcile(["x.md"]);

    expect(await vault.exists("x.md")).toBe(false); // removed from the vault (→ trash)
    expect(await registry.listPersisted()).not.toContain("x.md"); // persisted doc destroyed
    expect(serverText(serverDocs, "x.md")).toBe(""); // NOT pushed back up
    expect(deleted).toEqual([]); // removal used vault.remove, not api.deleteNote
    expect(cursor.knownServer).toEqual([]);
  });

  it("T2: still pushes a genuinely-new (never-known) local note — bring-existing preserved", async () => {
    const { crdt, vault, serverDocs } = makeSync({ "new.md": "brand new" });
    const cursor = await crdt.reconcile([]); // known empty
    await waitFor(() => serverText(serverDocs, "new.md") === "brand new");
    expect(serverText(serverDocs, "new.md")).toBe("brand new");
    expect(await vault.exists("new.md")).toBe(true); // file kept
    expect(cursor.knownServer).not.toContain("new.md"); // pushed, but not in the manifest → not in known
  });

  it("T4: leaves the ACTIVE note in place even if server-deleted (edit-beats-delete)", async () => {
    const { crdt, vault } = makeSync({ "x.md": "active content" });
    await crdt.open("x.md");
    await waitFor(() => crdt.ownsPath("x.md"));
    await crdt.reconcile(["x.md"]); // known says it was on the server; manifest empty
    expect(await vault.exists("x.md")).toBe(true); // not removed — the editor owns it
    await crdt.close();
  });

  it("T5: pulls a server-only note into the vault", async () => {
    const { crdt, vault, serverDocs, manifestState } = makeSync({});
    const sd = new Y.Doc();
    sd.getText("content").insert(0, "from server");
    serverDocs.set("y.md", sd);
    manifestState.entries = [{ path: "y.md" }];
    manifestState.head = 3;
    const cursor = await crdt.reconcile([]);
    await waitFor(() => vault.snapshot()["y.md"] === "from server");
    expect(vault.snapshot()["y.md"]).toBe("from server");
    expect(cursor.knownServer).toEqual(["y.md"]);
    expect(cursor.head).toBe(3);
  });

  it("T6: leaves a steady-state note (local ∧ on-server ∧ known) untouched", async () => {
    const { crdt, vault, serverDocs, manifestState } = makeSync({ "a.md": "shared" });
    const sd = new Y.Doc();
    sd.getText("content").insert(0, "shared");
    serverDocs.set("a.md", sd);
    manifestState.entries = [{ path: "a.md" }];
    manifestState.head = 1;
    const cursor = await crdt.reconcile(["a.md"]);
    expect(await vault.exists("a.md")).toBe(true);
    expect(vault.snapshot()["a.md"]).toBe("shared");
    expect(cursor.knownServer).toEqual(["a.md"]);
  });

  it("T7: returns knownServer = server contents ONLY (not unioned with freshly-pushed notes)", async () => {
    const { crdt, serverDocs, manifestState } = makeSync({ "a.md": "aaa", "new.md": "nnn" });
    const sd = new Y.Doc();
    sd.getText("content").insert(0, "aaa");
    serverDocs.set("a.md", sd);
    manifestState.entries = [{ path: "a.md" }];
    manifestState.head = 7;
    const cursor = await crdt.reconcile(["a.md"]);
    await waitFor(() => serverText(serverDocs, "new.md") === "nnn"); // new.md WAS pushed
    expect(cursor.head).toBe(7);
    expect(cursor.knownServer).toEqual(["a.md"]); // ONLY server paths — new.md excluded despite the push
  });

  it("T8: new + deleted + steady + pull all resolve correctly in one reconcile", async () => {
    const { crdt, registry, vault, serverDocs, manifestState } = makeSync({
      "steady.md": "s",
      "new.md": "n",
      "gone.md": "g",
    });
    for (const [p, t] of [
      ["steady.md", "s"],
      ["gone.md", "g"],
    ] as const) {
      const { note, whenLoaded } = registry.note(p);
      await whenLoaded;
      await note.applyFileEdit(t); // steady + gone have persisted docs (were synced)
    }
    await waitFor(async () => (await registry.listPersisted()).length >= 2);
    const ss = new Y.Doc();
    ss.getText("content").insert(0, "s");
    serverDocs.set("steady.md", ss);
    const sp = new Y.Doc();
    sp.getText("content").insert(0, "pulled");
    serverDocs.set("pull.md", sp);
    manifestState.entries = [{ path: "steady.md" }, { path: "pull.md" }];
    manifestState.head = 5;

    const cursor = await crdt.reconcile(["steady.md", "gone.md"]);

    await waitFor(() => serverText(serverDocs, "new.md") === "n"); // never-known → pushed
    expect(await vault.exists("gone.md")).toBe(false); // known, gone from server → removed
    expect(await vault.exists("steady.md")).toBe(true); // known, on server → untouched
    await waitFor(() => vault.snapshot()["pull.md"] === "pulled"); // server-only → pulled down
    expect([...cursor.knownServer].sort()).toEqual(["pull.md", "steady.md"]);
    expect(cursor.head).toBe(5);
  });

  it("reconcile ADOPT mode: pulls the remote vault down, trashes local-only cruft, pushes nothing", async () => {
    // Local Obsidian vault has only a Welcome note (cruft); the agent's remote vault has the real notes.
    const { crdt, vault, serverDocs, deleted, manifestState } = makeSync({
      "Welcome.md": "welcome to obsidian",
    });
    for (const [p, t] of [
      ["project.md", "the project"],
      ["areas/notes.md", "my notes"],
    ] as const) {
      const sd = new Y.Doc();
      sd.getText("content").insert(0, t);
      serverDocs.set(p, sd);
    }
    manifestState.entries = [{ path: "project.md" }, { path: "areas/notes.md" }];
    manifestState.head = 6;

    const cursor = await crdt.reconcile([], "adopt");

    // remote notes pulled down:
    await waitFor(
      () =>
        vault.snapshot()["project.md"] === "the project" &&
        vault.snapshot()["areas/notes.md"] === "my notes",
    );
    // local-only cruft trashed (→ Obsidian trash), not pushed:
    expect(await vault.exists("Welcome.md")).toBe(false);
    expect(serverText(serverDocs, "Welcome.md")).toBe(""); // nothing landed on the adopted vault
    expect(deleted).toEqual([]); // trashed via vault.remove, not a remote api.deleteNote
    expect([...cursor.knownServer].sort()).toEqual(["areas/notes.md", "project.md"]);
  });

  it("reconcile ADOPT mode: replaces a same-path divergent note with the remote — no conflict copy", async () => {
    // A fresh Obsidian folder ships a default Welcome.md; the adopted vault also has a Welcome.md (different
    // content). Adopt is remote-wins → the local Welcome is REPLACED by the server's, with NO
    // "(conflicted copy)" kept and nothing pushed back up (which would pollute the joined vault).
    const { crdt, vault, serverDocs, manifestState } = makeSync({
      "Welcome.md": "this is your new vault", // the local Obsidian default
    });
    const sw = new Y.Doc();
    sw.getText("content").insert(0, "welcome from the agent"); // the remote's Welcome — diverges
    serverDocs.set("Welcome.md", sw);
    const sp = new Y.Doc();
    sp.getText("content").insert(0, "the project");
    serverDocs.set("project.md", sp);
    manifestState.entries = [{ path: "Welcome.md" }, { path: "project.md" }];
    manifestState.head = 4;

    await crdt.reconcile([], "adopt");

    await waitFor(() => vault.snapshot()["Welcome.md"] === "welcome from the agent");
    expect(vault.snapshot()["Welcome.md"]).toBe("welcome from the agent"); // remote-wins replace
    expect(vault.snapshot()["Welcome (conflicted copy).md"]).toBeUndefined(); // NO keep-both
    await waitFor(() => vault.snapshot()["project.md"] === "the project");
    expect(vault.snapshot()["project.md"]).toBe("the project"); // remote-only pulled
    // nothing leaked up: the server Welcome keeps the agent text (not unioned with the local default), and
    // no conflict copy was created to sync up.
    expect(serverText(serverDocs, "Welcome.md")).toBe("welcome from the agent");
    expect(serverText(serverDocs, "Welcome (conflicted copy).md")).toBe("");
  });

  it("flushAll pushes every persisted note up (closing the active note first)", async () => {
    const { crdt, registry, serverDocs } = makeSync({ "a.md": "aa", "b.md": "bb" });
    for (const [p, t] of [
      ["a.md", "aa"],
      ["b.md", "bb"],
    ] as const) {
      const { note, whenLoaded } = registry.note(p);
      await whenLoaded;
      await note.applyFileEdit(t);
    }
    await waitFor(async () => (await registry.listPersisted()).length === 2);
    await crdt.open("a.md"); // a.md is the active note
    await waitFor(() => crdt.ownsPath("a.md"));

    await crdt.flushAll();

    expect(crdt.ownsPath("a.md")).toBe(false); // active note closed
    await waitFor(
      () => serverText(serverDocs, "a.md") === "aa" && serverText(serverDocs, "b.md") === "bb",
    );
    expect(serverText(serverDocs, "a.md")).toBe("aa"); // active note flushed
    expect(serverText(serverDocs, "b.md")).toBe("bb"); // non-active note flushed
  });

  it("ignores onLocalChange / onRemoteChange for the active note (the editor owns it)", async () => {
    const { crdt, serverDocs } = makeSync({ "act.md": "x" });
    await crdt.open("act.md");
    await waitFor(() => serverText(serverDocs, "act.md").includes("x")); // open seeded + synced "x"
    await crdt.onLocalChange("act.md", "y"); // no-op (active — the editor binding owns it)
    await crdt.onRemoteChange({ path: "act.md", op: "put" }); // no-op (active)
    await new Promise((r) => setTimeout(r, 20));
    expect(crdt.ownsPath("act.md")).toBe(true);
    expect(serverText(serverDocs, "act.md")).not.toContain("y"); // the ignored onLocalChange never pushed
    await crdt.close();
  });
});

describe("CrdtSync — durable delete queue (offline mutation durability)", () => {
  it("deleteLocal enqueues + persists the delete when the server delete fails, and re-throws", async () => {
    const { q, peek } = makeQueue();
    await q.init();
    const { crdt, registry } = makeSync({ "d.md": "x" }, { queue: q }, {
      deleteNote: () => Promise.reject(new Error("delete failed: 500")),
    });
    const { note, whenLoaded } = registry.note("d.md");
    await whenLoaded;
    await note.applyFileEdit("x"); // persisted local doc

    await expect(crdt.deleteLocal("d.md")).rejects.toThrow(/delete failed/);

    expect(q.list()).toContain("d.md"); // intent queued for retry
    expect(peek()).toEqual({ deletes: ["d.md"] }); // and durably persisted
    expect(registry.get("d.md")).toBeDefined(); // doc KEPT (no-orphan/no-resurrect)
  });

  it("drainPending replays a queued delete: deletes server-side, drops the doc, dequeues", async () => {
    const { q } = makeQueue({ deletes: ["gone.md"] });
    await q.init();
    // Post-offline-delete state: the .md is gone but its persisted doc was KEPT + the delete queued.
    const { crdt, registry, deleted } = makeSync({}, { queue: q });
    const { note, whenLoaded } = registry.note("gone.md");
    await whenLoaded;
    await note.applyFileEdit("x");
    await waitFor(async () => (await registry.listPersisted()).includes("gone.md"));

    await crdt.drainPending();

    expect(deleted).toEqual(["gone.md"]); // the delete finally landed server-side
    expect(registry.get("gone.md")).toBeUndefined(); // kept doc now dropped (confirmed gone)
    expect(q.list()).toEqual([]); // dequeued
  });

  it("drainPending is idempotent — an empty queue is a no-op", async () => {
    const { q } = makeQueue();
    await q.init();
    const { crdt, deleted } = makeSync({}, { queue: q });
    await crdt.drainPending();
    await crdt.drainPending();
    expect(deleted).toEqual([]);
  });

  it("drainPending KEEPS a queued delete when the server delete still fails (still offline)", async () => {
    const { q } = makeQueue({ deletes: ["gone.md"] });
    await q.init();
    const { crdt, registry } = makeSync({}, { queue: q }, {
      deleteNote: () => Promise.reject(new Error("delete failed: 503")),
    });
    const { note, whenLoaded } = registry.note("gone.md");
    await whenLoaded;
    await note.applyFileEdit("x");

    await crdt.drainPending();

    expect(q.list()).toEqual(["gone.md"]); // retained for the next drain
    expect(registry.get("gone.md")).toBeDefined(); // doc kept (not orphaned)
  });

  it("drainPending supersedes a queued delete whose .md was re-created locally (local wins)", async () => {
    const { q } = makeQueue({ deletes: ["back.md"] });
    await q.init();
    // The user re-created the note: its .md is back on disk. The stale delete intent must be dropped, NOT
    // sent (else the re-creation would be deleted). Doc-presence is not the signal — a queued delete keeps
    // its doc — the .md file is.
    const { crdt, deleted } = makeSync({ "back.md": "re-created" }, { queue: q });

    await crdt.drainPending();

    expect(deleted).toEqual([]); // no delete sent — the local re-creation supersedes
    expect(q.list()).toEqual([]); // stale intent dropped
  });

  it("reconcile drains pending deletes before reconciling", async () => {
    const { q } = makeQueue({ deletes: ["gone.md"] });
    await q.init();
    const { crdt, registry, deleted } = makeSync({}, { queue: q }); // manifest empty (server has nothing)
    const { note, whenLoaded } = registry.note("gone.md");
    await whenLoaded;
    await note.applyFileEdit("x");

    await crdt.reconcile([], "merge");

    expect(deleted).toEqual(["gone.md"]); // reconcile drained the queue first
    expect(q.list()).toEqual([]);
    expect(registry.get("gone.md")).toBeUndefined();
  });
});
