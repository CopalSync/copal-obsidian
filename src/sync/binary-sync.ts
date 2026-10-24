import { log } from "../log";
import { PreconditionError, type SyncApi } from "./api";
import type { BinaryCursor, BinaryEntry } from "./binary-cursor";
import { type BinaryFiles, mimeForPath } from "./binary-vault";
import { uniqueConflictName } from "./conflict-name";
import { fnv1a, fnv1aChunked } from "./fnv";
import type { MutationQueue } from "./mutation-queue";
import { runWithinBudget, type SizedTask } from "./run-bounded";
import { safePath } from "./safe-path";

/** One server entry for reconcile: an attachment path + its R2 etag (the manifest `version`). */
export interface BinaryManifestEntry {
	path: string;
	version: string;
	/** Server-side byte length, used to budget in-flight memory during reconcile (ROADMAP P4). Optional
	 *  because a caller may not have it; an unknown size is treated as 0, i.e. never the reason to park. */
	size?: number;
}

export interface BinarySyncDeps {
	/** Just the binary methods of `SyncApi` — kept narrow so the engine is easy to fake in tests. */
	api: Pick<SyncApi, "getFile" | "putFile" | "deleteFile">;
	files: BinaryFiles;
	cursor: BinaryCursor;
	/** This install's device id, stamped into conflict-copy names so two devices never collide. A
	 *  getter because `main.ts` reads it from the store after this is constructed. */
	deviceId?: () => string;
	/** Durable pending-delete queue (a second `MutationQueue` instance under the `binaryPending` key). */
	queue: MutationQueue;
	log?: (msg: string) => void;
}

/**
 * True if `path` is a syncable attachment: a non-`.md` vault file that `safePath` accepts. The
 * markdown/CRDT engine owns `.md`; this is its non-`.md` counterpart. Scope is deliberately
 * attachments-only — plugin/theme config never leaves the device.
 *
 * ⚠️ No prefix checks of its own (S1). It used to exclude `.obsidian/` and `.trash/` by exact-case
 * prefix, which let `.Obsidian/plugins/copal/main.js` through to a case-insensitive filesystem. `safePath`
 * refuses every dot-prefixed segment in any case, and a control char in the name (unroutable over HTTP,
 * so the /file request would 404-loop) too.
 */
export function isAttachmentPath(path: string): boolean {
	return !path.endsWith(".md") && safePath(path) !== null;
}

/** Max concurrent transfers during reconcile (bounded so a big vault doesn't open N requests at once). */
const RECONCILE_CONCURRENCY = 6;

/**
 * Attachments at or above this are skipped rather than synced. ROADMAP P4.
 *
 * ⚠️ The ceiling is about MEMORY, not politeness. `putFile`/`getFile` buffer the whole body, and
 * `MAX_FILE_BYTES` in `api.ts` already refuses a 100 MB download for the same reason — on a phone that
 * allocation IS the process. Skipping is loud (a one-time warning) rather than silent, because a file
 * that never syncs and never says so looks like data loss.
 */
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Total bytes allowed in flight across concurrent transfers. ROADMAP P4.
 *
 * Six concurrent 90 MB attachments is 540 MB resident; the concurrency limit alone cannot see that,
 * because it counts a 2 KB icon and a 90 MB video as one unit each.
 */
const MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;

/**
 * File-level last-writer-wins sync for binary attachments (images, PDFs, `.canvas`) — the non-`.md`
 * counterpart to `CrdtSync`. Binaries can't CRDT-merge, so each is synced whole, keyed on the **R2 etag**
 * (never mtime). A persisted per-path cursor (etag + local content hash) drives the classify decisions and
 * suppresses echoes: a file the plugin just wrote from a pull hashes to its known value, so it isn't
 * re-pushed. A conflicting write (412) keeps the local bytes as a labelled `(conflicted copy)` and takes
 * the server version — nothing is lost.
 */
export class BinarySync {
	constructor(private readonly deps: BinarySyncDeps) {}

	/** Download a server attachment into the vault + record its etag/hash (server-wins, in place). */
	async pull(path: string): Promise<void> {
		const file = await this.deps.api.getFile(path);
		if (file === null) return; // vanished between the manifest and the fetch
		await this.deps.files.writeBinary(path, file.bytes);
		await this.record(path, file.etag, await fnv1aChunked(new Uint8Array(file.bytes)));
	}

	/** Upload a local attachment if it changed since the last sync. On a 412 (server also changed) it keeps
	 *  a conflict copy of the local bytes, then last-writer-wins-pulls the server version. */
	async pushLocal(path: string): Promise<void> {
		// Check the size BEFORE reading: the point of the ceiling is never to allocate the buffer.
		const stat = await this.deps.files.stat(path);
		if (stat !== null && stat.size >= MAX_ATTACHMENT_BYTES)
			return this.skipTooLarge(path, stat.size);
		const bytes = await this.readSafe(path);
		if (bytes === null) return;
		const hash = await fnv1aChunked(new Uint8Array(bytes));
		const known = this.deps.cursor.get(path);
		if (known?.hash === hash) return; // unchanged since last sync → echo / no-op
		try {
			const { etag } = await this.deps.api.putFile(path, bytes, mimeForPath(path), known?.etag);
			await this.record(path, etag, hash);
		} catch (err) {
			if (err instanceof PreconditionError) {
				await this.resolveConflict(path, bytes);
				return;
			}
			throw err;
		}
	}

	/** Propagate a local delete to the server; on failure, durably queue it and rethrow (replayed on reconnect). */
	async deleteLocal(path: string): Promise<void> {
		try {
			await this.deps.api.deleteFile(path);
		} catch (err) {
			this.deps.queue.enqueueDelete(path);
			await this.deps.queue.persist();
			throw err;
		}
		this.deps.cursor.delete(path);
		await this.deps.cursor.persist();
		await this.dequeuePersisted(path);
	}

	/** Route a live journal frame: a delete trashes locally; a put pulls — unless it's our own echo (the
	 *  broadcast etag already equals the one we know), which is skipped. */
	async onRemoteChange(change: {
		path: string;
		op: "put" | "delete";
		version?: string;
	}): Promise<void> {
		if (change.op === "delete") {
			await this.deps.files.trash(change.path);
			this.deps.cursor.delete(change.path);
			await this.deps.cursor.persist();
			return;
		}
		if (
			change.version !== undefined &&
			this.deps.cursor.get(change.path)?.etag === change.version
		) {
			return; // our own write echoing back
		}
		await this.pull(change.path);
	}

	/**
	 * Reconcile the local attachments with the server manifest (startup / "Sync now"), tombstone-aware.
	 * `merge` (default) is a local-first union; `adopt` is remote-first (pull everything, trash local-only).
	 * The known-etag/hash cursor classifies each path — see the per-branch comments.
	 */
	async reconcile(manifest: BinaryManifestEntry[], mode: "merge" | "adopt"): Promise<void> {
		await this.drainPending(); // land any offline-queued deletes first, so the manifest is post-delete
		const serverByPath = new Map(manifest.map((e) => [e.path, e.version]));
		const serverSize = new Map(manifest.map((e) => [e.path, e.size ?? 0]));
		const localPaths = new Set(await this.deps.files.list());
		/** Each task carries what it will hold in memory, so the runner can cap total in-flight bytes. */
		const tasks: SizedTask[] = [];
		const push = (path: string, run: () => Promise<void>): void => {
			tasks.push({ bytes: serverSize.get(path) ?? 0, run });
		};

		for (const [path, etag] of serverByPath) {
			if (mode === "adopt") {
				push(path, () => this.pull(path)); // remote-first: overwrite local with the server version
				continue;
			}
			const known = this.deps.cursor.get(path);
			if (!localPaths.has(path)) {
				push(
					path,
					known === undefined
						? () => this.pull(path) // new remote file → download
						: () => this.deleteLocal(path), // known here but gone locally → local delete → propagate
				);
				continue;
			}
			push(path, () => this.reconcileLocalVsServer(path, etag, known));
		}

		for (const path of localPaths) {
			if (serverByPath.has(path)) continue;
			const known = this.deps.cursor.get(path);
			if (mode === "adopt" || known !== undefined) {
				push(path, () => this.trashLocal(path)); // adopt cruft, or a known-then-remotely-deleted file
			} else {
				push(path, () => this.pushLocal(path)); // genuinely-new local file → upload
			}
		}

		await runWithinBudget(RECONCILE_CONCURRENCY, MAX_IN_FLIGHT_BYTES, tasks);
		await this.deps.cursor.persist();
	}

	/**
	 * Record a synced attachment, including the local size/mtime the stat gate compares next time.
	 *
	 * ⚠️ The stat is read AFTER the write, not before: writing changes the mtime, so a stat taken first
	 * would be recorded stale and the gate would miss the very next change.
	 */
	private async record(path: string, etag: string, hash: string): Promise<void> {
		const stat = await this.deps.files.stat(path);
		this.deps.cursor.set(
			path,
			stat === null ? { etag, hash } : { etag, hash, size: stat.size, mtime: stat.mtime },
		);
		await this.deps.cursor.persist();
	}

	/** Warned about once per path per session, so a skipped file is visible without becoming spam. */
	private readonly warnedTooLarge = new Set<string>();

	private skipTooLarge(path: string, size: number): void {
		if (this.warnedTooLarge.has(path)) return;
		this.warnedTooLarge.add(path);
		const mb = Math.round(size / (1024 * 1024));
		log.warn(
			`skipping attachment over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit: ${JSON.stringify(path)} (${mb} MB). It stays in your vault but will not sync.`,
		);
	}

	/** Replay durably-queued deletes now connectivity may be back (WS reconnect + the top of reconcile). */
	async drainPending(): Promise<void> {
		const queue = this.deps.queue;
		if (queue.list().length === 0) return;
		for (const path of queue.list()) {
			// oxlint-disable-next-line no-await-in-loop -- sequential: gentle on the network + the data.json write
			if (await this.deps.files.exists(path)) {
				queue.dequeue(path); // re-created locally → the delete intent is stale
				continue;
			}
			try {
				// oxlint-disable-next-line no-await-in-loop
				await this.deps.api.deleteFile(path);
				this.deps.cursor.delete(path);
				queue.dequeue(path);
			} catch {
				/* still offline / server error → keep it for the next drain */
			}
		}
		// Concurrent, not sequential: two awaited writes cannot coalesce, and these two always land
		// together. One write reaches disk instead of two.
		await Promise.all([queue.persist(), this.deps.cursor.persist()]);
	}

	/**
	 * A local file that's also on the server: decide push / pull / conflict from the known cursor.
	 *
	 * ⚠️ **The stat gate comes first (ROADMAP P4).** This used to read and hash EVERY attachment on EVERY
	 * reconcile, on the main thread. When the server etag still matches what we last synced AND the local
	 * file's size and mtime are unchanged, neither side has moved and there is nothing to decide — so it
	 * returns without touching the bytes. A vault of 2,000 attachments went from 2,000 full reads per
	 * reconcile to none in the steady state.
	 *
	 * The gate is deliberately conservative: a cursor written before P4 has no `size`/`mtime`, and that
	 * absence means "unknown, so read it", never "unchanged".
	 */
	private async reconcileLocalVsServer(
		path: string,
		serverEtag: string,
		known: BinaryEntry | undefined,
	): Promise<void> {
		if (known !== undefined && serverEtag === known.etag && known.size !== undefined) {
			const stat = await this.deps.files.stat(path);
			if (stat !== null && stat.size === known.size && stat.mtime === known.mtime) {
				return; // neither side moved — no read, no hash
			}
			if (stat !== null && stat.size >= MAX_ATTACHMENT_BYTES)
				return this.skipTooLarge(path, stat.size);
		}
		const bytes = await this.readSafe(path);
		if (bytes === null) return this.pull(path); // can't read local → take the server copy
		const localHash = await fnv1aChunked(new Uint8Array(bytes));
		if (known === undefined) return this.reconcileUnknownBoth(path, bytes, localHash);
		if (serverEtag === known.etag) {
			if (localHash !== known.hash) await this.pushLocal(path); // local edit, server unchanged → push
			return;
		}
		// server changed since we last synced
		if (localHash === known.hash) return this.pull(path); // no local edit → server wins
		return this.resolveConflict(path, bytes); // both changed → keep-both
	}

	/** First time we see a path on BOTH sides with no shared history: identical bytes → adopt; else keep-both. */
	private async reconcileUnknownBoth(
		path: string,
		localBytes: ArrayBuffer,
		localHash: string,
	): Promise<void> {
		const file = await this.deps.api.getFile(path);
		if (file === null) return this.pushLocal(path); // vanished → push local
		const serverHash = fnv1a(new Uint8Array(file.bytes));
		if (serverHash === localHash) {
			this.deps.cursor.set(path, { etag: file.etag, hash: localHash }); // identical → just adopt the cursor
			return;
		}
		// divergent → keep local as a copy, under a name nothing else can already own
		await this.deps.files.writeBinary(await this.conflictCopyName(path), localBytes);
		await this.deps.files.writeBinary(path, file.bytes); // take server in place
		this.deps.cursor.set(path, { etag: file.etag, hash: serverHash });
	}

	/** A conflict-copy name that is not already taken on disk — never a fixed one, which overwrote the
	 *  previous copy the moment a note diverged twice. */
	private conflictCopyName(path: string): Promise<string> {
		return uniqueConflictName(
			path,
			{ at: new Date(), deviceId: this.deps.deviceId?.() ?? "" },
			(p) => this.deps.files.exists(p),
		);
	}

	private async resolveConflict(path: string, localBytes: ArrayBuffer): Promise<void> {
		await this.deps.files.writeBinary(await this.conflictCopyName(path), localBytes);
		this.deps.log?.(`binary conflict, kept a conflict copy: ${path}`);
		await this.pull(path); // server wins in place; the conflict copy propagates on its own next push
	}

	private async trashLocal(path: string): Promise<void> {
		await this.deps.files.trash(path);
		this.deps.cursor.delete(path);
	}

	private async readSafe(path: string): Promise<ArrayBuffer | null> {
		try {
			if (await this.deps.files.exists(path)) return await this.deps.files.readBinary(path);
		} catch {
			/* missing / unreadable */
		}
		return null;
	}

	private async dequeuePersisted(path: string): Promise<void> {
		const queue = this.deps.queue;
		if (!queue.list().includes(path)) return;
		queue.dequeue(path);
		await queue.persist();
	}
}
