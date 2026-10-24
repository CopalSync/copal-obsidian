import type * as Y from "yjs";
import { contentHash } from "../sync/hash";
import type { VaultWriter } from "../sync/vault";
import { diffToDelta } from "./diff-delta";

/**
 * Where a note's durable metadata lives. A port rather than the store itself, so `LocalNote` stays
 * free of IndexedDB and a test can hand it a plain object.
 */
export interface NoteMetaWriter {
	setMeta(
		path: string,
		patch: { serverSv?: Uint8Array | null; dirty?: boolean; fileHash?: string },
	): Promise<void>;
}

/** The durable metadata a note is hydrated with when it is opened. */
export interface NoteMeta {
	fileHash: string;
	serverSv: Uint8Array | undefined;
}

/**
 * Binds a note's **persisted** local Y.Doc (from `LocalDocStore`) to its `.md` file. Every external file
 * edit becomes a minimal op on the doc's *shared history* (`origin:"file"`) — never a divergent replace,
 * because the persisted doc carries the history — and remote/converged doc changes are materialized back
 * to the `.md`. A content-hash guard breaks the write→watcher→re-apply loop (the FileBridge trick). The
 * `.md` is a projection of the doc, exactly as R2 is on the server. Obsidian-free: `main.ts` supplies the
 * `VaultWriter` and feeds file changes.
 */
export class LocalNote {
	/** The persisted Y.Doc (owned by LocalDocStore) — the sync layer wraps it as a peer. */
	readonly doc: Y.Doc;
	private readonly ytext: Y.Text;
	private lastHash = "";
	/**
	 * The server's Yjs state vector as of this note's last successful batch exchange, so the next push can
	 * be a DIFF against it rather than the whole document. Persisted through {@link NoteMetaWriter} and
	 * restored by {@link hydrate}, so a reload no longer costs a full-state push per note.
	 *
	 * Undefined means "unknown", which is deliberately the same as "send everything" — never
	 * "send nothing".
	 */
	private serverState: Uint8Array | undefined;

	constructor(
		doc: Y.Doc,
		private readonly path: string,
		private readonly vault: VaultWriter,
		private readonly meta?: NoteMetaWriter,
	) {
		this.doc = doc;
		this.ytext = doc.getText("content");
	}

	/**
	 * Adopt this note's persisted metadata. Called by the registry once the doc has loaded.
	 *
	 * ⛔ **`fileHash` surviving a close is what makes eviction safe.** It was in-memory only, so a note
	 * that had been closed and reopened reported {@link fileStateUnknown} — and `adoptUnseenFileEdits`
	 * reads that as "the `.md` may hold an edit the doc has not seen", merges the file in, and cannot
	 * tell which side is newer. It therefore reverted freshly-pulled remote content. P1 had to drop its
	 * per-page doc release for precisely this; an LRU without this hydration would do the same thing on
	 * every eviction.
	 */
	hydrate(meta: NoteMeta): void {
		this.lastHash = meta.fileHash;
		this.serverState = meta.serverSv;
	}

	/** The current note text. */
	text(): string {
		return this.ytext.toString();
	}

	/**
	 * Apply an external `.md` edit as an op on the persisted doc. Hash-guarded against our own materialize
	 * coming back through the file watcher. The diff is the human's change with correct causal position
	 * (the doc kept the shared history), so it merges — it is not a divergent text.
	 */
	async applyFileEdit(fileText: string): Promise<void> {
		const h = await contentHash(fileText);
		if (h === this.lastHash) return; // our own materialize echoing back
		const delta = diffToDelta(this.ytext.toString(), fileText);
		if (delta) {
			this.doc.transact(() => {
				if (delta.delete > 0) this.ytext.delete(delta.index, delta.delete);
				if (delta.insert) this.ytext.insert(delta.index, delta.insert);
			}, "file");
		}
		this.lastHash = h;
		await this.meta?.setMeta(this.path, { fileHash: h });
	}

	/** Write the doc's text to the `.md` (its projection), hash-guarded so it can't loop. */
	async materialize(): Promise<void> {
		const text = this.ytext.toString();
		const h = await contentHash(text);
		if (h === this.lastHash) return; // file already matches the doc
		await this.vault.write(this.path, text);
		this.lastHash = h;
		await this.meta?.setMeta(this.path, { fileHash: h });
	}

	/**
	 * Whether this note has never seen its `.md`. `lastHash` is in-memory and starts empty, so a note
	 * created this run holds no record of what is on disk — that is "unknown", NOT "the file matches".
	 * A caller about to {@link materialize} must resolve the unknown first or it can overwrite an edit
	 * it never saw.
	 */
	fileStateUnknown(): boolean {
		return this.lastHash === "";
	}

	/** The last state vector the server reported, or `undefined` if this note has not exchanged yet. */
	serverSv(): Uint8Array | undefined {
		return this.serverState;
	}

	/** Record the server's state vector after a successful exchange, durably. */
	setServerSv(sv: Uint8Array): void {
		this.serverState = sv;
		void this.meta?.setMeta(this.path, { serverSv: sv });
	}

	/** Record whether the server is behind this note, so reconcile can find it without loading it. */
	setDirty(dirty: boolean): void {
		void this.meta?.setMeta(this.path, { dirty });
	}

	/** Subscribe to doc changes; the callback gets each update's origin (`"file"`, `"editor"`, a peer, …). */
	onChange(cb: (origin: unknown) => void): () => void {
		const handler = (_u: Uint8Array, origin: unknown): void => cb(origin);
		this.doc.on("update", handler);
		return () => this.doc.off("update", handler);
	}
}
