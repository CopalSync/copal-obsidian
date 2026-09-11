import { PreconditionError, type SyncApi } from "./api";
import type { BinaryCursor } from "./binary-cursor";
import { type BinaryFiles, mimeForPath } from "./binary-vault";
import { conflictName } from "./conflict-name";
import { fnv1a } from "./fnv";
import type { MutationQueue } from "./mutation-queue";
import { safePath } from "./safe-path";

/** One server entry for reconcile: an attachment path + its R2 etag (the manifest `version`). */
export interface BinaryManifestEntry {
	path: string;
	version: string;
}

export interface BinarySyncDeps {
	/** Just the binary methods of `SyncApi` — kept narrow so the engine is easy to fake in tests. */
	api: Pick<SyncApi, "getFile" | "putFile" | "deleteFile">;
	files: BinaryFiles;
	cursor: BinaryCursor;
	/** Durable pending-delete queue (a second `MutationQueue` instance under the `binaryPending` key). */
	queue: MutationQueue;
	log?: (msg: string) => void;
}

/**
 * True if `path` is a syncable attachment: a non-`.md` vault file that isn't Obsidian config (`.obsidian`)
 * or trash. The markdown/CRDT engine owns `.md`; this is its non-`.md` counterpart. Scope is deliberately
 * attachments-only — plugin/theme config never leaves the device.
 */
export function isAttachmentPath(path: string): boolean {
	return (
		!path.endsWith(".md") &&
		!path.startsWith(".obsidian/") &&
		!path.startsWith(".trash/") &&
		// A control char in the name (e.g. from a shared social post) can't be routed over HTTP — the /file
		// request 404s — so it's not syncable; skip it rather than retry-loop.
		safePath(path) !== null
	);
}

/** Max concurrent transfers during reconcile (bounded so a big vault doesn't open N requests at once). */
const RECONCILE_CONCURRENCY = 6;

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
		this.deps.cursor.set(path, { etag: file.etag, hash: fnv1a(new Uint8Array(file.bytes)) });
		await this.deps.cursor.persist();
	}

	/** Upload a local attachment if it changed since the last sync. On a 412 (server also changed) it keeps
	 *  a conflict copy of the local bytes, then last-writer-wins-pulls the server version. */
	async pushLocal(path: string): Promise<void> {
		const bytes = await this.readSafe(path);
		if (bytes === null) return;
		const hash = fnv1a(new Uint8Array(bytes));
		const known = this.deps.cursor.get(path);
		if (known?.hash === hash) return; // unchanged since last sync → echo / no-op
		try {
			const { etag } = await this.deps.api.putFile(path, bytes, mimeForPath(path), known?.etag);
			this.deps.cursor.set(path, { etag, hash });
			await this.deps.cursor.persist();
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
		const localPaths = new Set(await this.deps.files.list());
		const tasks: Array<() => Promise<void>> = [];

		for (const [path, etag] of serverByPath) {
			if (mode === "adopt") {
				tasks.push(() => this.pull(path)); // remote-first: overwrite local with the server version
				continue;
			}
			const known = this.deps.cursor.get(path);
			if (!localPaths.has(path)) {
				tasks.push(
					known === undefined
						? () => this.pull(path) // new remote file → download
						: () => this.deleteLocal(path), // known here but gone locally → local delete → propagate
				);
				continue;
			}
			tasks.push(() => this.reconcileLocalVsServer(path, etag, known));
		}

		for (const path of localPaths) {
			if (serverByPath.has(path)) continue;
			const known = this.deps.cursor.get(path);
			if (mode === "adopt" || known !== undefined) {
				tasks.push(() => this.trashLocal(path)); // adopt cruft, or a known-then-remotely-deleted file
			} else {
				tasks.push(() => this.pushLocal(path)); // genuinely-new local file → upload
			}
		}

		await runBounded(RECONCILE_CONCURRENCY, tasks);
		await this.deps.cursor.persist();
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
		await queue.persist();
		await this.deps.cursor.persist();
	}

	/** A local file that's also on the server: decide push / pull / conflict from the known cursor. */
	private async reconcileLocalVsServer(
		path: string,
		serverEtag: string,
		known: { etag: string; hash: string } | undefined,
	): Promise<void> {
		const bytes = await this.readSafe(path);
		if (bytes === null) return this.pull(path); // can't read local → take the server copy
		const localHash = fnv1a(new Uint8Array(bytes));
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
		await this.deps.files.writeBinary(conflictName(path), localBytes); // divergent → keep local as a copy
		await this.deps.files.writeBinary(path, file.bytes); // take server in place
		this.deps.cursor.set(path, { etag: file.etag, hash: serverHash });
	}

	private async resolveConflict(path: string, localBytes: ArrayBuffer): Promise<void> {
		await this.deps.files.writeBinary(conflictName(path), localBytes);
		this.deps.log?.(`binary conflict — kept a conflict copy: ${path}`);
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

/** Run `thunks` with at most `limit` in flight; a thrown thunk is swallowed (best-effort transfer). */
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
