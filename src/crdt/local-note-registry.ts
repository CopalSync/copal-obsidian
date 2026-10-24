import type { LocalDocStore } from "./local-doc-store";
import { LocalNote } from "./local-note";
import type { VaultWriter } from "../sync/vault";

/**
 * Most notes held in memory at once. A page of the batched handshake is 100 and the note open in the
 * editor is one more, so 128 leaves headroom for a page plus the active note without evicting anything
 * that is in use — while still bounding a 10,000-note vault to a set a phone can hold.
 */
const MAX_RESIDENT = 128;

/**
 * Lazily creates and caches a `LocalNote` per path over a shared `LocalDocStore`. The single place the
 * rest of the plugin gets a note's persisted local Y.Doc and its `.md` binding; `main.ts` routes every
 * edit and every sync flush through it, so a note has exactly one local doc.
 *
 * **Bounded, and pinned (P2).** Docs used to accumulate forever: a first import of 10,000 notes left
 * 10,000 Y.Docs and their persistence resident, which is what made a large vault unusable on a phone.
 * This keeps at most {@link MAX_RESIDENT} and evicts least-recently-used ones — but **never a pinned
 * path**. Pins are what stop an eviction pulling a doc out from under work in progress: the note open in
 * the editor holds one for as long as it is open, and the batched sync holds one for every path in the
 * page it is exchanging.
 *
 * Eviction is `store.close`, which keeps the stored data, so it costs a read to come back — not a
 * re-sync. Safe only because the note's file hash and the server's state vector are persisted; without
 * that a reopened note looks like it has never seen its `.md` and the older file is merged back over
 * freshly-pulled content. See `LocalNote.hydrate`.
 */
export class LocalNoteRegistry {
	/** Insertion-ordered, and re-inserted on touch, so iteration order IS least-recently-used first. */
	private readonly notes = new Map<string, LocalNote>();
	private readonly pins = new Map<string, number>();

	constructor(
		private readonly store: LocalDocStore,
		private readonly vault: VaultWriter,
		private readonly maxResident: number = MAX_RESIDENT,
	) {}

	/** Get (or lazily create) the note's `LocalNote`; `whenLoaded` resolves once its doc is rehydrated. */
	note(path: string): { note: LocalNote; whenLoaded: Promise<void> } {
		const existing = this.notes.get(path);
		if (existing) {
			this.touch(path, existing);
			return { note: existing, whenLoaded: Promise.resolve() };
		}
		const { doc, whenLoaded } = this.store.open(path);
		const note = new LocalNote(doc, path, this.vault, this.store);
		this.notes.set(path, note);
		// Hydration rides `whenLoaded`, so every caller that already awaits it gets a note that knows
		// what is on disk and what the server has — no extra await at any call site.
		const ready = whenLoaded.then(async () => {
			const record = await this.store.record(path);
			note.hydrate({
				fileHash: record.fileHash,
				serverSv: record.serverSv === null ? undefined : new Uint8Array(record.serverSv),
			});
		});
		// `keep` is this path: a doc must never be evicted by its own creation. Callers are expected to
		// `acquire` before `note`, and production does, but a caller that pins afterwards would otherwise
		// find the doc it just asked for already closed — a footgun rather than a rule worth documenting.
		this.evictIfNeeded(path);
		return { note, whenLoaded: ready };
	}

	/** Move a path to the most-recently-used end. */
	private touch(path: string, note: LocalNote): void {
		this.notes.delete(path);
		this.notes.set(path, note);
	}

	/**
	 * Pin `path` so it cannot be evicted, and return the release. Held by the active note and by every
	 * path in an in-flight sync page.
	 */
	acquire(path: string): () => void {
		this.pins.set(path, (this.pins.get(path) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return; // idempotent: a double release must not unpin somebody else's hold
			released = true;
			const count = (this.pins.get(path) ?? 1) - 1;
			if (count <= 0) this.pins.delete(path);
			else this.pins.set(path, count);
		};
	}

	isPinned(path: string): boolean {
		return (this.pins.get(path) ?? 0) > 0;
	}

	/** How many notes are held in memory. For tests, and for reasoning about a phone. */
	residentCount(): number {
		return this.notes.size;
	}

	/** Close least-recently-used unpinned notes until the resident set is back inside its bound. */
	private evictIfNeeded(keep?: string): void {
		if (this.notes.size <= this.maxResident) return;
		// oxlint-disable-next-line unicorn/no-useless-spread -- iterating a SNAPSHOT: the body mutates this map
		for (const path of [...this.notes.keys()]) {
			if (this.notes.size <= this.maxResident) return;
			if (path === keep) continue;
			if (this.isPinned(path)) continue;
			this.close(path);
		}
		// Everything over the bound is pinned. That is correct rather than a failure — the pins are held
		// by work in flight and are released when it finishes — so the set is allowed to exceed the bound
		// briefly instead of evicting a doc somebody is using.
	}

	/** The note if it's already open in memory (no creation). */
	get(path: string): LocalNote | undefined {
		return this.notes.get(path);
	}

	/** Every note that already has a persisted local doc (so reconcile can skip it). */
	listPersisted(): Promise<string[]> {
		return this.store.listPersisted();
	}

	/** Notes holding ops the server may not have — read from the index, without loading any of them. */
	listDirty(): Promise<string[]> {
		return this.store.listDirty();
	}

	/** Rename a note `oldPath` → `newPath`, preserving its CRDT lineage (delegates to the store), and drop
	 *  the stale cached `LocalNote` so the new path is lazily re-wrapped over the renamed doc. */
	async rename(oldPath: string, newPath: string): Promise<void> {
		this.notes.delete(oldPath);
		await this.store.rename(oldPath, newPath);
	}

	/** Drop the note from memory (keeps its persisted data). */
	close(path: string): void {
		this.store.close(path);
		this.notes.delete(path);
	}

	/** Flush and drop every note, and close the database. Teardown. */
	async closeAll(): Promise<void> {
		this.notes.clear();
		this.pins.clear();
		await this.store.closeAll();
	}

	/** Permanently delete the note's persisted local data (confirmed remote delete / bring-existing purge). */
	async destroy(path: string): Promise<void> {
		this.notes.delete(path);
		this.pins.delete(path);
		await this.store.destroy(path);
	}

	/** Wipe every persisted local doc + drop the in-memory cache (clean disconnect). */
	async destroyAll(): Promise<void> {
		this.notes.clear();
		this.pins.clear();
		await this.store.destroyAll();
	}
}
