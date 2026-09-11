import type { SyncApi } from "../sync/api";
import { type BinarySync, isAttachmentPath } from "../sync/binary-sync";
import { conflictName } from "../sync/conflict-name";
import type { MutationQueue } from "../sync/mutation-queue";
import { safePath } from "../sync/safe-path";
import type { VaultWriter } from "../sync/vault";
import { CrdtNote, type YTransport } from "./crdt-note";
import type { LocalNote } from "./local-note";
import type { LocalNoteRegistry } from "./local-note-registry";
import { WsTransport } from "./ws-transport";

export interface CrdtSyncDeps {
	api: SyncApi;
	registry: LocalNoteRegistry;
	vault: VaultWriter;
	/** Durable pending-mutation queue: an offline/failed delete is queued here + replayed on reconnect /
	 *  reconcile, so a fully-offline delete is guaranteed-delivered instead of silently lost. */
	queue?: MutationQueue;
	/** File-level last-writer-wins sync for non-`.md` attachments. The CRDT engine is markdown-only, so a
	 *  binary journal entry / manifest path is routed here instead of the (text) CRDT — the quarantine seam. */
	binarySync?: BinarySync;
	/** Create a connected transport to a note's YNoteDO. Injected for tests; default mints a ticket + WS. */
	transportFor?: (path: string) => Promise<YTransport>;
	/** Bind the active editor to the connected peer's Y.Text once synced (main.ts supplies this). */
	bind?: (peer: CrdtNote) => void;
	/** Unbind the editor on close/switch. */
	unbind?: () => void;
	/** Read the LIVE editor buffer for `path`, but only when it's the note currently open in the editor
	 *  (else `null`). Captures a brand-new note's unsaved keystrokes — which aren't flushed to disk yet — so
	 *  seeding an empty doc from the file (and materialize writing "" back) can't wipe them. */
	readActiveText?: (path: string) => string | null;
	/** Settle window (ms) to let a transient sync flush + materialize before disconnecting. */
	settleMs?: number;
	log?: (msg: string) => void;
}

/** Safety cap: proceed even if the initial sync never signals completion (e.g. a network failure). */
const SYNC_TIMEOUT_MS = 8000;
/** Default settle window before disconnecting a transient sync (lets the ops flush + materialize). */
const DEFAULT_SETTLE_MS = 1500;

/**
 * Local-first note-text sync. Every note is a **persisted** local Y.Doc (LocalDocStore, via the registry);
 * this layer connects those docs to their `YNoteDO` and exchanges Yjs **ops** — so sync is state-vector
 * based and convergence is automatic, never a hash-pull, a seed-overwrite, or a clobber. The **active**
 * note holds a live socket + editor binding; a **non-active** note that changed (locally or remotely) is
 * transiently connected, its ops exchanged, materialized to `.md`, and disconnected. Because the local doc
 * persists shared history, an offline/closed edit is just an op that merges on connect — no divergence.
 */
export class CrdtSync {
	private active: { path: string; peer: CrdtNote; transport: YTransport } | undefined;
	private readonly inFlight = new Map<string, Promise<void>>();

	constructor(private readonly deps: CrdtSyncDeps) {}

	/** True while the active note owns this path (so the vault watcher leaves the editor binding alone). */
	ownsPath(path: string): boolean {
		return this.active?.path === path;
	}

	private transportFor(path: string): Promise<YTransport> {
		if (this.deps.transportFor) return this.deps.transportFor(path);
		const urlFor = async (): Promise<string> => {
			const { ticket, url } = await this.deps.api.ycrdtTicket();
			return `${url}/${path.split("/").map(encodeURIComponent).join("/")}?ticket=${encodeURIComponent(ticket)}`;
		};
		const t = new WsTransport(urlFor);
		t.connect();
		return Promise.resolve(t);
	}

	/** Open the active note: connect its persisted local doc to the DO (op-exchange) + bind the editor. */
	async open(path: string): Promise<void> {
		if (this.active?.path === path) return;
		await this.close(); // unbind the previous note first, even if the new one turns out unsyncable
		// A control char in the filename (e.g. a newline from a shared social post) can't be routed over HTTP,
		// so the /ycrdt WS 404s and the transport would reconnect-loop forever. Skip it — the note stays a
		// plain local file (edits don't sync) rather than taking the whole connection down.
		if (safePath(path) === null) {
			this.deps.log?.(`skipping unsyncable path (invalid characters in name): ${path}`);
			return;
		}
		const { note, whenLoaded } = this.deps.registry.note(path);
		await whenLoaded; // the persisted history must be loaded before we send our state vector
		const transport = await this.transportFor(path);
		const peer = new CrdtNote(transport, note.doc);
		this.active = { path, peer, transport };
		void this.seedAndBind(path, note, peer);
	}

	/**
	 * Adopt an existing local `.md` into a fresh (empty) persisted doc as an op — the first time a note is
	 * opened after there's a file but no local CRDT history yet. If the server also has content, the
	 * subsequent op-exchange **unions** both (CRDT merge) — zero loss, never a clobber. (A cleaner labelled
	 * boundary for genuinely-independent first-import divergence is P7; the zero-loss guarantee holds now.)
	 */
	private async seedFromFileIfEmpty(note: LocalNote, path: string): Promise<void> {
		if (note.text().length > 0) return; // the doc already carries history
		// Prefer the LIVE editor buffer over the file on disk: a brand-new note the user just started typing
		// into may not be autosaved yet, so reading the file would miss their keystrokes — and then
		// `materialize()` would write "" back over the open editor, WIPING them. `readActiveText` returns null
		// for a non-active note, so we fall back to the file on disk (the correct source for closed notes).
		const editorText = this.deps.readActiveText?.(path) ?? "";
		const text = editorText.length > 0 ? editorText : await this.readFileSafe(path);
		if (text.length > 0) await note.applyFileEdit(text);
	}

	private async seedAndBind(path: string, note: LocalNote, peer: CrdtNote): Promise<void> {
		// SYNC FIRST (adopt the server's ops), THEN reconcile the local file — so an existing note isn't
		// duplicated by seeding the file into an empty doc before its server content has arrived.
		const wasEmpty = note.text().length === 0;
		await Promise.race([peer.whenSynced(), new Promise((r) => setTimeout(r, SYNC_TIMEOUT_MS))]);
		if (this.active?.path !== path) return;
		await this.reconcileFileAfterSync(note, path, wasEmpty);
		// Only write the .md when the live editor is OUT OF SYNC with the doc (i.e. there's remote content to
		// project down). When we just seeded the doc FROM the editor (a new note), the editor already matches —
		// writing the file would reload + race the open editor and could clobber the user's keystrokes. The
		// editor binding + Obsidian's autosave own the file in that case.
		if (this.deps.readActiveText?.(path) !== note.text()) {
			await note.materialize(); // project the converged doc into the .md
		}
		this.deps.bind?.(peer);
	}

	/**
	 * Close the active note: unbind the editor + disconnect its socket. The persisted doc stays in the
	 * registry (in memory + IndexedDB) — no destroy, so there's no flush race; unloading idle docs is P6.
	 */
	close(): Promise<void> {
		if (!this.active) return Promise.resolve();
		const active = this.active;
		this.active = undefined;
		this.deps.unbind?.();
		active.peer.disconnect(); // closes the socket; does NOT destroy the injected persisted doc
		return Promise.resolve();
	}

	/** A remote change to a non-active note → transient op-sync into its persisted doc + materialize. */
	async onRemoteChange(change: {
		path: string;
		op: "put" | "delete";
		version?: string;
	}): Promise<void> {
		if (this.active?.path === change.path) return; // the editor binding owns the live note
		// The CRDT engine is markdown-only (Yjs text). A non-.md journal entry (e.g. a binary written via
		// WebDAV/MCP/another device) must never be CRDT-pulled as text — route an attachment to the file-level
		// last-writer-wins transport (BinarySync) instead; anything else (e.g. config) is skipped.
		if (!isMarkdownPath(change.path)) {
			if (this.deps.binarySync && isAttachmentPath(change.path)) {
				return this.deps.binarySync.onRemoteChange(change);
			}
			this.deps.log?.(`skipping non-syncable remote change: ${change.path}`);
			return;
		}
		if (change.op === "delete") {
			await this.deps.vault.remove(change.path); // → Obsidian trash (recoverable), never a hard unlink
			await this.deps.registry.destroy(change.path); // drop the persisted local doc
			return;
		}
		return this.syncOnce(change.path);
	}

	/** A local edit to a non-active note → apply it as an op on the persisted doc, then op-sync it up. */
	async onLocalChange(path: string, text: string): Promise<void> {
		if (this.active?.path === path) return; // the editor binding owns the live note
		return this.syncOnce(path, text);
	}

	/**
	 * Propagate a local delete (the user deleted a note / renamed away): delete it remotely, then drop the
	 * persisted doc — **but only if the server delete succeeded** (a 404 counts, `api.deleteNote` swallows it).
	 * On a real failure we KEEP the persisted doc and re-throw: destroying an orphaned-but-still-served note
	 * would let it resurrect on the next reconcile (server keeps it / local forgets it). The caller surfaces
	 * the throw (a Notice); the tombstone-aware `reconcile` retries the removal once the server delete lands.
	 */
	async deleteLocal(path: string): Promise<void> {
		try {
			await this.deps.api.deleteNote(path);
		} catch (err) {
			this.deps.log?.(
				`delete propagate failed for ${path}: ${err instanceof Error ? err.message : err}`,
			);
			// Durably queue the intent so it's replayed on reconnect — a fully-offline delete must not be lost.
			if (this.deps.queue) {
				this.deps.queue.enqueueDelete(path);
				await this.deps.queue.persist();
			}
			throw err; // keep the persisted doc — never orphan a still-served note (it would resurrect)
		}
		await this.deps.registry.destroy(path); // confirmed gone remotely → drop the local doc
		await this.dequeuePersisted(path); // clear any prior queued intent for this path
	}

	/** Drop `path` from the durable queue + persist, but only if it was queued (avoid a needless write). */
	private async dequeuePersisted(path: string): Promise<void> {
		const queue = this.deps.queue;
		if (!queue || !queue.list().includes(path)) return;
		queue.dequeue(path);
		await queue.persist();
	}

	/**
	 * Replay durably-queued deletes now that connectivity may have returned (called on WS reconnect + at the
	 * start of `reconcile`). For each queued path: if its `.md` is **back on disk** it was re-created locally
	 * → drop the stale intent (the local re-creation wins — the persisted doc is NOT the signal here, since a
	 * queued delete deliberately KEEPS its doc). Otherwise delete it server-side (a 404 counts as done, the
	 * API swallows it) → drop the kept doc → dequeue. A still-failing delete is retained for the next drain.
	 * Idempotent; safe to call repeatedly (a no-op on an empty queue).
	 */
	async drainPending(): Promise<void> {
		const queue = this.deps.queue;
		if (!queue || queue.list().length === 0) return;
		for (const path of queue.list()) {
			// oxlint-disable-next-line no-await-in-loop -- sequential: gentle on the socket + the data.json write
			if (await this.deps.vault.exists(path)) {
				queue.dequeue(path); // re-created locally → the delete intent is stale
				continue;
			}
			try {
				// oxlint-disable-next-line no-await-in-loop
				await this.deps.api.deleteNote(path);
				// oxlint-disable-next-line no-await-in-loop
				await this.deps.registry.destroy(path); // confirmed gone → drop the kept doc
				queue.dequeue(path);
			} catch {
				/* still offline / server error → keep it for the next drain */
			}
		}
		await queue.persist();
	}

	/**
	 * Rename a note `oldPath` → `newPath`, **preserving its CRDT history** end to end. The server-side
	 * `moveNote` transfers the note's Yjs update log + R2 object to the new path and tombstones the old, and
	 * `registry.rename` transfers the *local* persisted doc lineage — so both replicas keep the identical
	 * struct history and converge instantly (not a fresh Y.Doc). A rename does NOT fire `file-open`, so an
	 * active note's live socket + editor binding stay pinned to the OLD path; `close()` tears them down first
	 * so they can't re-push the old path. If the server move fails (offline / unsupported), fall back to
	 * `deleteLocal(oldPath)` (durably queued when offline — no orphan/resurrect) + upload the new path from its
	 * `.md`. Either way the editor follows the note to `newPath`.
	 */
	async rename(oldPath: string, newPath: string): Promise<void> {
		const wasActive = this.ownsPath(oldPath);
		if (wasActive) await this.close(); // stop the OLD socket + editor binding (no auto-reconnect / re-push)
		try {
			await this.deps.api.moveNote(oldPath, newPath); // server: transfer history + R2, tombstone old
			await this.deps.registry.rename(oldPath, newPath); // local: transfer the persisted doc lineage old→new
		} catch (err) {
			this.deps.log?.(
				`server move ${oldPath}→${newPath} failed (${err instanceof Error ? err.message : err}); ` +
					`falling back to delete-old + upload-new`,
			);
			try {
				await this.deleteLocal(oldPath); // durably queues on offline + keeps the old doc (no resurrect)
			} catch {
				/* deleteLocal already queued the delete + kept the doc; the new path uploads below */
			}
		}
		if (wasActive)
			await this.open(newPath); // rebind the editor to the (rekeyed) new doc → converges w/ server
		else await this.syncOnce(newPath); // establish/converge the new-path local doc
	}

	/** Transiently connect a note's persisted doc, exchange ops, materialize, disconnect. Coalesced per path. */
	private syncOnce(
		path: string,
		applyFileText?: string,
		settleMs?: number,
		adopt = false,
	): Promise<void> {
		if (this.active?.path === path) return Promise.resolve();
		// Never transient-sync an unroutable path (control chars in the name) — its /ycrdt WS would 404-loop.
		if (safePath(path) === null) return Promise.resolve();
		const existing = this.inFlight.get(path);
		if (existing) return existing;
		const p = this.doSync(path, applyFileText, settleMs, adopt).finally(() =>
			this.inFlight.delete(path),
		);
		this.inFlight.set(path, p);
		return p;
	}

	private async doSync(
		path: string,
		applyFileText?: string,
		settleMs?: number,
		adopt = false,
	): Promise<void> {
		const { note, whenLoaded } = this.deps.registry.note(path);
		await whenLoaded;
		const wasEmpty = note.text().length === 0;
		const transport = await this.transportFor(path);
		const peer = new CrdtNote(transport, note.doc);
		try {
			// SYNC FIRST — adopt the server's ops into the persisted doc (shared history) before reconciling the
			// file, so we never seed the file into an empty doc that also has equivalent server content (which
			// would duplicate the text).
			await Promise.race([peer.whenSynced(), new Promise((r) => setTimeout(r, SYNC_TIMEOUT_MS))]);
			await this.reconcileFileAfterSync(note, path, wasEmpty, applyFileText, adopt);
			await note.materialize(); // converged doc → its .md projection
			await new Promise((r) => setTimeout(r, settleMs ?? this.deps.settleMs ?? DEFAULT_SETTLE_MS));
		} finally {
			peer.disconnect();
			transport.close();
		}
	}

	/**
	 * After sync, reconcile the local file with the (now server-synced) doc:
	 *  - `applyFileText` given → apply the human's edit as a delta on the synced doc;
	 *  - doc still empty (server had nothing) → seed a genuinely-new local note from the file;
	 *  - **first import** (doc was empty, server had content) with a local file that genuinely **diverged**:
	 *    on `merge` → keep the local text as a labelled `(conflicted copy)` (the one place two independent
	 *    texts meet, so nothing is ever lost); on `adopt` (remote-wins) → discard the local text and let the
	 *    server doc win. Then adopt the server doc either way.
	 *  - steady state → nothing (the file is a projection of the doc).
	 */
	private async reconcileFileAfterSync(
		note: LocalNote,
		path: string,
		wasEmpty: boolean,
		applyFileText?: string,
		adopt = false,
	): Promise<void> {
		if (applyFileText !== undefined) {
			await note.applyFileEdit(applyFileText);
			return;
		}
		if (note.text().length === 0) {
			await this.seedFromFileIfEmpty(note, path);
			return;
		}
		if (!wasEmpty) return; // steady state — the file is already a projection of the doc
		const fileText = await this.readFileSafe(path);
		if (fileText.length > 0 && fileText !== note.text()) {
			// ADOPT is remote-wins: discard the local text — `materialize()` (next) overwrites the .md with the
			// server content in place (its hash-guard stops that write echoing back up). MERGE never loses local
			// data → keep it as a labelled conflict copy.
			if (adopt) return;
			await this.deps.vault.write(conflictName(path), fileText); // keep-both (first-import divergence)
			this.deps.log?.(`first-import divergence, kept a conflict copy: ${path}`);
		}
	}

	private async readFileSafe(path: string): Promise<string> {
		try {
			if (await this.deps.vault.exists(path)) return await this.deps.vault.read(path);
		} catch {
			/* missing / unreadable */
		}
		return "";
	}

	/**
	 * Reconcile (startup / Sync-now): converge the local vault with the server, **tombstone-aware**. The
	 * **local** set is every persisted CRDT doc ∪ every `.md` file. Given `known` (the paths that were on the
	 * server as of the last reconcile), a local note absent from the server is classified:
	 *  - **Pull** — a server note absent locally → download (no local content to flush → no settle window).
	 *  - **Push (new)** — local, not on the server, and **never known** here → bring-existing upload (even a
	 *    never-opened file, seeded post-sync, so it keeps the default settle to flush its seeded op).
	 *  - **Remove (deleted)** — local, not on the server, but **was known** → a remote delete → trash the file
	 *    + drop the persisted doc, instead of resurrecting it. Without this, a delete that never reached the
	 *    plugin live (offline, or the active-note skip) would be re-pushed on the next reconcile.
	 * The **active** note is skipped everywhere (its live socket owns it; open ≠ editing, but a note being
	 * edited must never be yanked out from under the user — its socket re-unions the content up = edit-beats-
	 * delete). Returns the new cursor for `SyncClient` to persist **before** it opens the WS: `knownServer` is
	 * the reconciled server contents ONLY (deliberately not unioned with `toPush` — a push is best-effort with
	 * no server ack, so recording an un-landed push would make the next reconcile trash a brand-new note),
	 * and `head` advances `lastSeq` so the WS resumes from this snapshot (post-snapshot deletes arrive live).
	 */
	async reconcile(
		known: readonly string[] = [],
		mode: "merge" | "adopt" = "merge",
	): Promise<{ knownServer: string[]; head: number }> {
		await this.drainPending(); // land any offline-queued deletes FIRST, so the manifest below is post-delete
		const { head, manifest } = await this.deps.api.manifest();
		const serverPaths = new Set(manifest.map((e) => e.path));
		const local = new Set([
			...(await this.deps.registry.listPersisted()),
			...(await this.deps.vault.list()),
		]);
		const knownSet = new Set(known);
		const active = this.active?.path;
		// ADOPT pulls EVERY server note (remote-wins) so a same-path note is replaced during the adopt rather
		// than left to a lazy open (which would keep-both). MERGE pulls only remote-only notes.
		const toPull = manifest
			.filter(
				(e) =>
					e.path !== active && isMarkdownPath(e.path) && (mode === "adopt" || !local.has(e.path)),
			)
			.map((e) => e.path);
		// ADOPT (remote-first): the remote vault is authoritative — push nothing, and trash EVERY local-only
		// note (not just previously-known ones) so local cruft never lands on the adopted vault. MERGE
		// (local-first union): push genuinely-new local notes; only trash notes that were known-then-deleted.
		const toPush =
			mode === "adopt"
				? []
				: [...local].filter((p) => !serverPaths.has(p) && !knownSet.has(p) && p !== active);
		const toRemove = [...local].filter(
			(p) => !serverPaths.has(p) && p !== active && (mode === "adopt" || knownSet.has(p)),
		);
		await runBounded(RECONCILE_CONCURRENCY, [
			...toPull.map((p) => () => this.syncOnce(p, undefined, 0, mode === "adopt")),
			...toPush.map((p) => () => this.syncOnce(p, undefined)),
		]);
		await Promise.all(
			toRemove.map(async (path) => {
				await this.deps.vault.remove(path); // → Obsidian trash (recoverable)
				await this.deps.registry.destroy(path); // drop the persisted local doc so it can't re-push
			}),
		);
		// Seam: the same manifest, partitioned by extension. Attachments (non-`.md`) are NEVER in the CRDT
		// sets above (`vault.list()` is markdown-only), so they can't reach `syncOnce` — they reconcile on the
		// file-level LWW channel instead, which persists its own known-etag cursor.
		if (this.deps.binarySync) {
			const binaryEntries = manifest
				.filter((e) => isAttachmentPath(e.path))
				.map((e) => ({ path: e.path, version: e.version }));
			await this.deps.binarySync.reconcile(binaryEntries, mode);
		}
		return { knownServer: [...serverPaths], head };
	}

	/**
	 * Flush every persisted note UP to the server before teardown (the clean-disconnect sync-first step).
	 * Closes the active note first so it's no longer skipped by `syncOnce`, then transient-syncs each
	 * persisted path (op-exchange pushes local ops up + materializes). Best-effort: a note that can't reach
	 * the server times out and moves on — the `.md` file is the safety net (reconnect brings-existing it up).
	 */
	async flushAll(): Promise<void> {
		await this.close(); // drop the active note's live socket; its persisted doc keeps its latest edits
		const paths = await this.deps.registry.listPersisted();
		await runBounded(
			RECONCILE_CONCURRENCY,
			paths.map((p) => () => this.syncOnce(p)),
		);
	}
}

/** The CRDT engine is markdown-only (Yjs text). Non-`.md` server paths are quarantined here (the Phase-B
 *  binary-sync seam) so a binary never gets pulled through the text CRDT and corrupted. */
function isMarkdownPath(path: string): boolean {
	return path.endsWith(".md");
}

/** Max concurrent first-import syncs during reconcile (bounded so a big vault doesn't open N sockets). */
const RECONCILE_CONCURRENCY = 6;

/** Run `thunks` with at most `limit` in flight; a thrown thunk is swallowed (best-effort populate). */
async function runBounded(limit: number, thunks: Array<() => Promise<void>>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < thunks.length) {
			const idx = next++;
			await thunks[idx]?.().catch(() => undefined);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
}
