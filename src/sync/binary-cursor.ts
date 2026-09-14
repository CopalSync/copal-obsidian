import type { DataSlice } from "../data/plugin-data-store";

/** One tracked attachment: the server `etag` we last synced, plus a local content `hash` (FNV-1a) so a
 *  file the plugin just wrote from a pull isn't mistaken for a local edit (echo suppression). */
export interface BinaryEntry {
	etag: string;
	hash: string;
}

/** The persisted attachment cursor, under the `binary` key of the plugin's `data.json`. */
export interface BinaryData {
	known: Record<string, BinaryEntry>;
}

/**
 * The last-writer-wins cursor for binary attachments — the file-level analogue of `SyncState.knownServer`
 * (which the markdown/CRDT path uses). For each attachment path it records the last-synced server etag +
 * local content hash, so reconcile can classify a path (pull / push / conflict / delete) and the live
 * watcher can skip echoes. Persisted under `data.json`'s `binary` key via the same read-modify-write idiom
 * as `SyncState`/`MutationQueue` (all coexist in the one record).
 */
export class BinaryCursor {
	private data: BinaryData = { known: {} };

	constructor(private readonly slice: DataSlice<BinaryData>) {}

	/** Synchronous, and the slice's copy is this cursor's own — see `SyncState.init`. */
	init(): void {
		const loaded = this.slice.get();
		this.data = { known: loaded?.known ?? {} };
	}

	get(path: string): BinaryEntry | undefined {
		return this.data.known[path];
	}

	set(path: string, entry: BinaryEntry): void {
		this.data.known[path] = entry;
	}

	delete(path: string): void {
		delete this.data.known[path];
	}

	/** Every path with a known etag/hash (the file-level tombstone signal, like `knownServer`). */
	paths(): string[] {
		return Object.keys(this.data.known);
	}

	async persist(): Promise<void> {
		await this.slice.set(this.data);
	}

	/** Wipe the cursor (on disconnect) so stale etags can't bleed into the next linked vault's reconcile. */
	async reset(): Promise<void> {
		this.resetInMemory();
		await this.persist();
	}

	/** The same wipe without the write, for a caller batching every persister's reset into one. */
	resetInMemory(): void {
		this.data = { known: {} };
	}
}
