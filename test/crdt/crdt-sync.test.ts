import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CrdtNote, type YTransport } from "../../src/crdt/crdt-note";
import { CrdtSync, type CrdtSyncDeps } from "../../src/crdt/crdt-sync";
import { asVaultId, LocalDocStore } from "../../src/crdt/local-doc-store";
import { LocalNoteRegistry } from "../../src/crdt/local-note-registry";
import type { SyncApi, YSyncRequest, YSyncResult } from "../../src/sync/api";
import { base64ToBytes, bytesToBase64 } from "../../src/sync/base64";
import { type MutationData, MutationQueue } from "../../src/sync/mutation-queue";
import { memSlice } from "../data/fake-plugin-data";
import { InMemoryVault } from "../sync/fake-vault";

/** A fixed vault id, supplied the way the production factory supplies one. */
const vaultIdOf = (id: string) => () => Promise.resolve(asVaultId(id));

/** A MutationQueue backed by an in-memory `data.json` record (mirrors the real `pending`-key persistence). */
async function makeQueue(initial: MutationData | null = null) {
	const m = await memSlice("pending", initial ?? undefined);
	const q = new MutationQueue(m.slice);
	q.init();
	return { q, peek: (): MutationData | undefined => m.peek() };
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
		/** Awaited before each transient connect (the ACTIVE note only now), so a test can hold it open. */
		beforeTransport?: (path: string) => Promise<void>;
		/** Awaited before each batched page, so a test can hold a page open mid-flight. */
		beforePage?: (paths: string[]) => Promise<void>;
		/** Force a page to fail, to exercise the retry path. */
		failPage?: () => boolean;
	} = {},
) {
	const store = new LocalDocStore(vaultIdOf(`t${++tenantN}`));
	const vault = new InMemoryVault(vaultFiles);
	const registry = new LocalNoteRegistry(store, vault);
	const serverDocs = new Map<string, Y.Doc>();
	const transportFor = async (path: string): Promise<YTransport> => {
		await opts.beforeTransport?.(path);
		const { a, b } = pairedTransports();
		let serverDoc = serverDocs.get(path);
		if (!serverDoc) {
			serverDoc = new Y.Doc();
			serverDocs.set(path, serverDoc);
		}
		new CrdtNote(b, serverDoc); // a fresh server peer wrapping the persistent server doc
		return a;
	};
	const bound: CrdtNote[] = [];
	const deleted: string[] = [];
	const moved: [string, string][] = [];
	// A mutable server manifest the fake `api.manifest()` reads at reconcile time (paths + journal head).
	const manifestState: { head: number; entries: { path: string; version?: string }[] } = {
		head: 0,
		entries: [],
	};
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
	const pages: string[][] = [];
	/**
	 * The batched handshake, standing in for `POST /ycrdt/sync` + `YNoteDO.sync`. It does exactly what the
	 * real server does per item, which is the point: apply the client's diff to the persistent server doc,
	 * then answer with the diff that doc holds against the client's state vector, plus its own vector.
	 *
	 * ⚠️ It answers in REVERSE request order on purpose. The response is not promised to be ordered, and a
	 * client that pairs results by position rather than by path applies one note's ops to another — a fault
	 * that every "all paths present" assertion stays green for.
	 */
	const ycrdtSync = async (body: YSyncRequest): Promise<YSyncResult[]> => {
		await opts.beforePage?.(body.items.map((i) => i.path));
		pages.push(body.items.map((i) => i.path));
		if (opts.failPage?.()) throw new Error("page failed");
		const out: YSyncResult[] = [];
		for (const item of body.items) {
			let doc = serverDocs.get(item.path);
			if (!doc) {
				doc = new Y.Doc();
				serverDocs.set(item.path, doc);
			}
			if (item.update !== undefined) Y.applyUpdate(doc, base64ToBytes(item.update), "batch");
			out.push({
				path: item.path,
				ok: true,
				update: bytesToBase64(Y.encodeStateAsUpdate(doc, base64ToBytes(item.sv))),
				sv: bytesToBase64(Y.encodeStateVector(doc)),
			});
		}
		return out.reverse();
	};
	const crdt = new CrdtSync({
		api: {
			manifest: () =>
				Promise.resolve({ head: manifestState.head, manifest: manifestState.entries }),
			deleteNote: opts.deleteNote ?? defaultDelete,
			moveNote: opts.moveNote ?? defaultMove,
			ycrdtSync,
		} as unknown as SyncApi,
		registry,
		vault,
		transportFor,
		debounceMs: 0,
		bind: (peer) => bound.push(peer),
		...extra,
	});
	return { crdt, registry, vault, serverDocs, bound, deleted, moved, manifestState, pages };
}
const serverText = (docs: Map<string, Y.Doc>, path: string) =>
	docs.get(path)?.getText("content").toString() ?? "";

/** Conflict copies carry a time + device stamp (S8), so they are found by shape, not by a literal. */
function conflictCopies(snapshot: Record<string, string>, base: string): string[] {
	const [stem, ext] = [base.replace(/\.md$/, ""), ".md"];
	return Object.keys(snapshot).filter(
		(k) => k.startsWith(`${stem} (conflicted copy `) && k.endsWith(ext),
	);
}

describe("CrdtSync (local-first op-sync)", () => {
	it("onLocalChange applies a file edit as an op and syncs it up to the server", async () => {
		const { crdt, serverDocs } = makeSync({ "n.md": "hello world" });
		await crdt.onLocalChange("n.md");
		await waitFor(() => serverText(serverDocs, "n.md") === "hello world");
		expect(serverText(serverDocs, "n.md")).toBe("hello world");
	});

	it("captures a brand-new note's unsaved editor content on open (never wipes it)", async () => {
		// Repro of the wipe bug: a NEW note (empty on the server) whose file on disk is still empty because
		// Obsidian hasn't autosaved the user's keystrokes yet. Seeding from the disk would miss them and
		// materialize would write "" back over the editor. `readActiveText` exposes the live editor buffer.
		const typed = "hello I just started typing this";
		const { crdt, serverDocs } = makeSync(
			{ "fresh.md": "" }, // disk file empty (unsaved)
			{ readActiveText: (p) => (p === "fresh.md" ? typed : null) },
		);

		await crdt.open("fresh.md");

		// The keystrokes are captured into the doc and synced UP (old behaviour lost them → server stayed "").
		await waitFor(() => serverText(serverDocs, "fresh.md") === typed);
		expect(serverText(serverDocs, "fresh.md")).toBe(typed);
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

	// A filename with a control char (e.g. a newline from a shared social post) can't be routed over HTTP —
	// the /ycrdt WS 404s and the client would reconnect-loop forever. It must be skipped, so one bad-named
	// note never opens a socket / breaks the rest of the vault's sync.
	it("open() skips a path with control characters — never opens a socket for an unsyncable filename", async () => {
		const { crdt, serverDocs } = makeSync({});
		await crdt.open("EmDash CMS (@x)\n18 likes.md");
		expect(serverDocs.has("EmDash CMS (@x)\n18 likes.md")).toBe(false); // no transport/DO connection
	});

	it("onLocalChange skips a control-character path (never transient-syncs an unsyncable filename)", async () => {
		const { crdt, serverDocs } = makeSync({});
		await crdt.onLocalChange("bad\nname.md");
		expect(serverDocs.has("bad\nname.md")).toBe(false);
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

	it("routes a non-markdown remote change to BinarySync (never the text CRDT)", async () => {
		const binarySync = { onRemoteChange: vi.fn(() => Promise.resolve()) };
		const { crdt, vault } = makeSync(
			{},
			{ binarySync: binarySync as unknown as NonNullable<CrdtSyncDeps["binarySync"]> },
		);
		await crdt.onRemoteChange({ path: "image.png", op: "put", version: "e1" });
		expect(binarySync.onRemoteChange).toHaveBeenCalledWith({
			path: "image.png",
			op: "put",
			version: "e1",
		});
		expect(vault.snapshot()["image.png"]).toBeUndefined(); // never CRDT-materialized as text
	});

	it("reconcile delegates the binary manifest entries to BinarySync while .md flows through the CRDT", async () => {
		const binarySync = {
			onRemoteChange: vi.fn(() => Promise.resolve()),
			reconcile: vi.fn(() => Promise.resolve()),
		};
		const { crdt, serverDocs, vault, manifestState } = makeSync(
			{},
			{ binarySync: binarySync as unknown as NonNullable<CrdtSyncDeps["binarySync"]> },
		);
		const md = new Y.Doc();
		md.getText("content").insert(0, "note body");
		serverDocs.set("note.md", md);
		manifestState.entries = [
			{ path: "note.md", version: "m1" },
			{ path: "pic.png", version: "p1" },
			{ path: "doc.pdf", version: "d1" },
		];
		await crdt.reconcile([], "merge");
		await waitFor(() => vault.snapshot()["note.md"] === "note body");
		// The binary entries (and only those) were handed to BinarySync — never the CRDT.
		expect(binarySync.reconcile).toHaveBeenCalledTimes(1);
		expect(binarySync.reconcile).toHaveBeenCalledWith(
			[
				{ path: "pic.png", version: "p1" },
				{ path: "doc.pdf", version: "d1" },
			],
			"merge",
		);
		// No binary ever became a CRDT server doc or a materialized text file.
		expect(serverDocs.has("pic.png")).toBe(false);
		expect(vault.snapshot()["pic.png"]).toBeUndefined();
	});

	it("UNIONS an offline local edit with a concurrent server edit — zero loss", async () => {
		const { crdt, serverDocs, registry } = makeSync({ "n.md": "BASE\n" });
		await crdt.onLocalChange("n.md"); // establish shared history (read from the file at dequeue)
		await waitFor(() => serverText(serverDocs, "n.md") === "BASE\n");

		// Both diverge OFFLINE (no connection between the two edits).
		// ⚠️ `whenLoaded` is awaited because a finished page RELEASES a fully-synced note's doc (the mobile
		// memory guarantee), so re-taking it here is a genuine reload from IndexedDB rather than a cache hit.
		const { note, whenLoaded } = registry.note("n.md");
		await whenLoaded;
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
		const copies = conflictCopies(vault.snapshot(), "n.md");
		expect(copies, "no stamped conflict copy was kept").toHaveLength(1);
		expect(vault.snapshot()[copies[0]!]).toBe("LOCAL VERSION"); // local text preserved
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
		const { crdt, registry } = makeSync(
			{ "d.md": "x" },
			{},
			{
				deleteNote: () => Promise.reject(new Error("delete failed: 500")),
			},
		);
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
		const { crdt, vault, serverDocs, deleted } = makeSync(
			{ "old.md": "hello" },
			{},
			{
				moveNote: () => Promise.reject(new Error("move failed: 503")),
			},
		);
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
		const { q } = await makeQueue();
		await q.init();
		const { crdt, registry, vault } = makeSync(
			{ "old.md": "hello" },
			{ queue: q },
			{
				moveNote: () => Promise.reject(new Error("offline")),
				deleteNote: () => Promise.reject(new Error("offline")),
			},
		);
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
			() =>
				serverText(serverDocs, "a.md") === "note A" && serverText(serverDocs, "b.md") === "note B",
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
		expect(conflictCopies(vault.snapshot(), "Welcome.md")).toHaveLength(0); // NO keep-both
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
		const { crdt, serverDocs, vault } = makeSync({ "act.md": "x" });
		await crdt.open("act.md");
		await waitFor(() => serverText(serverDocs, "act.md").includes("x")); // open seeded + synced "x"
		await vault.write("act.md", "xy"); // a real on-disk change for the watcher path to pick up
		await crdt.onLocalChange("act.md"); // no-op (active — the editor binding owns it)
		await crdt.onRemoteChange({ path: "act.md", op: "put" }); // no-op (active)
		await new Promise((r) => setTimeout(r, 20));
		expect(crdt.ownsPath("act.md")).toBe(true);
		expect(serverText(serverDocs, "act.md")).not.toContain("y"); // the ignored onLocalChange never pushed
		await crdt.close();
	});
});

describe("CrdtSync — durable delete queue (offline mutation durability)", () => {
	it("deleteLocal enqueues + persists the delete when the server delete fails, and re-throws", async () => {
		const { q, peek } = await makeQueue();
		await q.init();
		const { crdt, registry } = makeSync(
			{ "d.md": "x" },
			{ queue: q },
			{
				deleteNote: () => Promise.reject(new Error("delete failed: 500")),
			},
		);
		const { note, whenLoaded } = registry.note("d.md");
		await whenLoaded;
		await note.applyFileEdit("x"); // persisted local doc

		await expect(crdt.deleteLocal("d.md")).rejects.toThrow(/delete failed/);

		expect(q.list()).toContain("d.md"); // intent queued for retry
		expect(peek()).toEqual({ deletes: ["d.md"] }); // and durably persisted
		expect(registry.get("d.md")).toBeDefined(); // doc KEPT (no-orphan/no-resurrect)
	});

	it("drainPending replays a queued delete: deletes server-side, drops the doc, dequeues", async () => {
		const { q } = await makeQueue({ deletes: ["gone.md"] });
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
		const { q } = await makeQueue();
		await q.init();
		const { crdt, deleted } = makeSync({}, { queue: q });
		await crdt.drainPending();
		await crdt.drainPending();
		expect(deleted).toEqual([]);
	});

	it("drainPending KEEPS a queued delete when the server delete still fails (still offline)", async () => {
		const { q } = await makeQueue({ deletes: ["gone.md"] });
		await q.init();
		const { crdt, registry } = makeSync(
			{},
			{ queue: q },
			{
				deleteNote: () => Promise.reject(new Error("delete failed: 503")),
			},
		);
		const { note, whenLoaded } = registry.note("gone.md");
		await whenLoaded;
		await note.applyFileEdit("x");

		await crdt.drainPending();

		expect(q.list()).toEqual(["gone.md"]); // retained for the next drain
		expect(registry.get("gone.md")).toBeDefined(); // doc kept (not orphaned)
	});

	it("drainPending supersedes a queued delete whose .md was re-created locally (local wins)", async () => {
		const { q } = await makeQueue({ deletes: ["back.md"] });
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
		const { q } = await makeQueue({ deletes: ["gone.md"] });
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

/**
 * ⛔ **THE PRICE OF THE LEGACY PURGE, measured rather than assumed.**
 *
 * Discarding the constant-tenant documents (F3) throws away the lineage that tells a stale local file
 * apart from a genuinely unknown one. `reconcileFileAfterSync` treats an empty local doc as a first
 * import, so a note this device was BEHIND on comes back as a keep-both conflict copy instead of a
 * silent merge. Nothing is lost either way — that is what keep-both is for — but a vault can sprout one
 * copy per note that had drifted, and that must be a stated cost rather than a surprise.
 *
 * Both halves run against the same server docs and the same files on disk. The only difference is
 * whether the local CRDT store survived the upgrade.
 */
describe("a note this device was behind on, across an upgrade", () => {
	/** A second process against an EXISTING server: same docs, fresh local store. */
	function reopenWithEmptyStore(vault: InMemoryVault, serverDocs: Map<string, Y.Doc>) {
		const registry = new LocalNoteRegistry(new LocalDocStore(vaultIdOf(`t${++tenantN}`)), vault);
		const crdt = new CrdtSync({
			api: {
				manifest: () => Promise.resolve({ head: 0, manifest: [] }),
				deleteNote: () => Promise.resolve(),
				moveNote: () => Promise.resolve(),
			} as unknown as SyncApi,
			registry,
			vault,
			transportFor: (path: string) => {
				const { a, b } = pairedTransports();
				let doc = serverDocs.get(path);
				if (!doc) {
					doc = new Y.Doc();
					serverDocs.set(path, doc);
				}
				new CrdtNote(b, doc);
				return Promise.resolve(a);
			},
			debounceMs: 0,
			bind: () => undefined,
		});
		return crdt;
	}

	/** Replace the server's text the way another device would: as ops on the shared doc. */
	function serverEdit(serverDocs: Map<string, Y.Doc>, path: string, text: string): void {
		const t = serverDocs.get(path)!.getText("content");
		t.delete(0, t.length);
		t.insert(0, text);
	}

	async function behindByOneEdit() {
		const first = makeSync({ "n.md": "OLD" });
		await first.crdt.open("n.md");
		await waitFor(() => serverText(first.serverDocs, "n.md") === "OLD");
		await first.crdt.close();
		serverEdit(first.serverDocs, "n.md", "NEW"); // edited on another device
		return first;
	}

	it("merges silently when the local history survived", async () => {
		const first = await behindByOneEdit();
		await first.crdt.open("n.md");
		await waitFor(() => first.vault.snapshot()["n.md"] === "NEW");
		expect(conflictCopies(first.vault.snapshot(), "n.md")).toHaveLength(0);
	});

	it("leaves a conflict copy when the purge took the local history with it", async () => {
		const first = await behindByOneEdit();

		const after = reopenWithEmptyStore(first.vault, first.serverDocs);
		await after.open("n.md");
		await waitFor(() => first.vault.snapshot()["n.md"] === "NEW");

		// The note itself ends up correct; the stale local text is kept beside it rather than dropped.
		expect(first.vault.snapshot()["n.md"]).toBe("NEW");
		const kept = conflictCopies(first.vault.snapshot(), "n.md");
		expect(kept, "the purge left no conflict copy").toHaveLength(1);
		expect(first.vault.snapshot()[kept[0]!]).toBe("OLD");
	});
});

/**
 * P6. The in-flight guard used to hand a second caller the FIRST call's promise and drop its text, so a
 * burst of autosaves lost everything after the first. The fix queues the *path* and reads the file when
 * the job runs, which is why these tests drive the vault rather than passing text in.
 */
describe("P6: a local edit is never lost", () => {
	it("syncs the newest text after a burst, not the text current when the burst started", async () => {
		let pagesStarted = 0;
		let gate: Promise<void> | undefined;
		let open!: () => void;
		const { crdt, vault, serverDocs } = makeSync(
			{ "n.md": "A" },
			{},
			{
				beforePage: async () => {
					pagesStarted += 1;
					await gate;
				},
			},
		);

		// ⚠️ Establish shared history FIRST. With an empty doc the sync takes the seed-from-file branch,
		// which reads the file late and would make this pass for the wrong reason.
		await crdt.onLocalChange("n.md");
		await waitFor(() => serverText(serverDocs, "n.md") === "A");
		gate = new Promise<void>((r) => (open = r));
		pagesStarted = 0;

		await vault.write("n.md", "A first edit");
		const first = crdt.onLocalChange("n.md");
		// ⚠️ NOT a bare `await Promise.resolve()`. The first page has to genuinely reach the network before
		// the second notify, or this rides a page that never started and passes for the wrong reason.
		await waitFor(() => pagesStarted > 0);

		await vault.write("n.md", "A second edit, moments later");
		const second = crdt.onLocalChange("n.md");

		open();
		await Promise.all([first, second]);

		await waitFor(() => serverText(serverDocs, "n.md") === "A second edit, moments later");
		expect(serverText(serverDocs, "n.md"), "the newest text never reached the server").toBe(
			"A second edit, moments later",
		);
	});

	/**
	 * The other half of the same data loss. `lastHash` is in-memory and starts empty, so a LocalNote that
	 * has just been created knows nothing about what is on disk — and the code used to read that "unknown"
	 * as "safe to overwrite", materializing the doc straight over a newer `.md`.
	 */
	it("merges a .md that changed while its LocalNote was gone, instead of overwriting it", async () => {
		const { crdt, registry, vault, serverDocs } = makeSync({ "n.md": "the original" });
		await crdt.onLocalChange("n.md");
		await waitFor(() => serverText(serverDocs, "n.md") === "the original");

		// A reload: the cached LocalNote — the only record of what was last written to disk — is gone,
		// while the file has since changed. Nothing queues a local edit for it, so nothing heals it.
		registry.close("n.md");
		await vault.write("n.md", "the original, edited while nothing was watching");

		await crdt.flushAll(); // sign-out / disconnect syncs every persisted note

		expect(vault.snapshot()["n.md"], "the newer .md was overwritten by the older doc").toBe(
			"the original, edited while nothing was watching",
		);
		expect(serverText(serverDocs, "n.md"), "the edit never reached the server either").toBe(
			"the original, edited while nothing was watching",
		);
	});

	/** Read-at-dequeue means the job routinely reads back the plugin's OWN materialize. `applyFileEdit`'s
	 *  hash guard is the only thing stopping that becoming a fresh edit — and another sync after it. */
	it("does not re-apply its own materialize as a user edit", async () => {
		const { crdt, registry, vault, serverDocs } = makeSync({ "n.md": "start" });
		await crdt.onLocalChange("n.md");
		await waitFor(() => serverText(serverDocs, "n.md") === "start");

		const sd = serverDocs.get("n.md")!;
		sd.getText("content").insert(sd.getText("content").length, " plus remote");
		await crdt.onRemoteChange({ path: "n.md", op: "put" });
		await waitFor(() => vault.snapshot()["n.md"] === "start plus remote");

		// Obsidian's watcher now fires for the write we just made ourselves.
		await crdt.onLocalChange("n.md");

		const { note, whenLoaded } = registry.note("n.md");
		await whenLoaded;
		expect(note.text(), "the echo was applied as a second edit").toBe("start plus remote");
		expect(serverText(serverDocs, "n.md")).toBe("start plus remote");
		expect(vault.snapshot()["n.md"]).toBe("start plus remote");
	});

	/**
	 * Under the batched path this is the pager's dedupe guarantee: a remote change for a path already
	 * queued merges into the same entry instead of buying a second exchange. It used to mean "ride the
	 * in-flight transient socket"; the cost being avoided — a whole extra round trip per note — is the same.
	 */
	it("folds a remote change for an already-queued path into one exchange", async () => {
		let pagesStarted = 0;
		let gate: Promise<void> | undefined;
		let open!: () => void;
		const { crdt, serverDocs, pages } = makeSync(
			{ "n.md": "A" },
			{},
			{
				beforePage: async () => {
					pagesStarted += 1;
					await gate;
				},
			},
		);
		await crdt.onLocalChange("n.md");
		await waitFor(() => serverText(serverDocs, "n.md") === "A");
		gate = new Promise<void>((r) => (open = r));
		pagesStarted = 0;
		pages.length = 0;

		const local = crdt.onLocalChange("n.md");
		await waitFor(() => pagesStarted > 0);
		const remote = crdt.onRemoteChange({ path: "n.md", op: "put" });

		open();
		await Promise.all([local, remote]);

		// The path appears once per exchange, never twice in one page.
		for (const page of pages) expect(page.filter((x) => x === "n.md")).toHaveLength(1);
	});
});

/**
 * P1 at scale. The old path minted a ticket and opened a WebSocket per closed note, then slept 1.5s:
 * 10k notes took ~53 minutes and ~10k metered calls, which a solo plan (2,000/day) cannot finish.
 */
describe("P1: closed notes sync in pages", () => {
	it("syncs 500 notes in a handful of exchanges, opening no sockets at all", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 500; i++) files[`n${i}.md`] = `body ${i}`;
		let connects = 0;
		const { crdt, serverDocs, pages, manifestState } = makeSync(
			files,
			{},
			{ beforeTransport: async () => void (connects += 1) },
		);
		manifestState.head = 7;

		await crdt.reconcile([], "merge");

		// 500 notes in pages of 100 — each page is ONE request and one metered call.
		expect(pages.length).toBeLessThanOrEqual(12);
		for (const page of pages) expect(page.length).toBeLessThanOrEqual(100);
		// ⛔ Not one socket. Sockets are now only the active note and the change bus.
		expect(connects, "a closed note opened its own socket").toBe(0);
		for (let i = 0; i < 500; i++) {
			expect(serverText(serverDocs, `n${i}.md`)).toBe(`body ${i}`);
		}
	});

	/**
	 * ⛔ The lost-edit guarantee, at burst scale. Obsidian autosaves repeatedly while a page is in flight,
	 * and the old code handed each later caller the first call's promise and dropped its text — so the
	 * server kept the text that was current when the burst STARTED.
	 */
	it("coalesces a burst of repeated edits and lands the LAST text of every note", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 120; i++) files[`b${i}.md`] = "v0";
		const { crdt, vault, serverDocs, pages } = makeSync(files);

		// Establish shared history so the burst exercises the edit path, not the seed path.
		await crdt.reconcile([], "merge");
		pages.length = 0;
		const baseline = pages.length;

		// 40 of them are edited ten times over, in flight.
		const hot = Array.from({ length: 40 }, (_, i) => `b${i}.md`);
		const bursts: Promise<void>[] = [];
		for (let round = 1; round <= 10; round++) {
			for (const path of hot) {
				// oxlint-disable-next-line no-await-in-loop
				await vault.write(path, `v${round}`);
				bursts.push(crdt.onLocalChange(path));
			}
		}
		await Promise.all(bursts);
		await crdt.idle();

		// Every hot note holds its FINAL text, server-side and on disk.
		for (const path of hot) {
			expect(serverText(serverDocs, path), `${path} did not land its last edit`).toBe("v10");
			expect(vault.snapshot()[path]).toBe("v10");
		}
		// 400 notifies did not become 400 exchanges.
		expect(pages.length - baseline).toBeLessThan(40);
	});

	/**
	 * ⚠️ Results must be paired with their own path. The fake server answers in REVERSE request order
	 * (the response is not promised to be ordered), so a client pairing by position would apply one
	 * note's ops to another — and "every path came back" stays green while it happens.
	 */
	it("pairs each result with its own path even when the server answers out of order", async () => {
		const { crdt, serverDocs } = makeSync({});
		const sa = new Y.Doc();
		sa.getText("content").insert(0, "alpha");
		serverDocs.set("a.md", sa);
		const sb = new Y.Doc();
		sb.getText("content").insert(0, "bravo");
		serverDocs.set("b.md", sb);
		const sc = new Y.Doc();
		sc.getText("content").insert(0, "charlie");
		serverDocs.set("c.md", sc);

		await crdt.onRemoteChange({ path: "a.md", op: "put" });
		await crdt.onRemoteChange({ path: "b.md", op: "put" });
		await crdt.onRemoteChange({ path: "c.md", op: "put" });
		await crdt.idle();

		const snap = (crdt as unknown as { deps: { vault: InMemoryVault } }).deps.vault.snapshot();
		expect(snap["a.md"]).toBe("alpha");
		expect(snap["b.md"]).toBe("bravo");
		expect(snap["c.md"]).toBe("charlie");
	});

	it("trashes a note the server reports GONE instead of resurrecting it", async () => {
		const { crdt, vault, registry } = makeSync({ "dead.md": "doomed" });
		// The server reports the note tombstoned — deleted on another device, and we had not heard.
		const api = (crdt as unknown as { deps: { api: { ycrdtSync: unknown } } }).deps.api;
		api.ycrdtSync = (body: YSyncRequest): Promise<YSyncResult[]> =>
			Promise.resolve(body.items.map((i) => ({ path: i.path, ok: false, code: "GONE" })));

		await crdt.onLocalChange("dead.md");
		await crdt.idle();

		expect(vault.snapshot()["dead.md"], "a GONE note was left on disk").toBeUndefined();
		expect(await registry.listPersisted()).not.toContain("dead.md");
	});
});
