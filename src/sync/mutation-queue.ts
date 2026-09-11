/** The durable pending-mutation queue, under the `pending` key of the plugin's `data.json`. */
export interface MutationData {
	/** Note paths whose remote delete has NOT yet landed (offline / failed) — retried on reconnect. */
	deletes: string[];
}

/**
 * A durable queue of structural mutations that must reach the server but couldn't yet (offline / a failed
 * `DELETE`). Note *text* survives offline for free (the local persisted Y.Doc merges on reconnect), but a
 * delete is a network op with no CRDT history — so its intent is persisted here and replayed when
 * connectivity returns, instead of being silently lost. Persisted under `data.json`'s `pending` key via the
 * same read-modify-write idiom as `SyncState` (both coexist in the one record). Deletes dedup by path
 * (delete-by-identity is idempotent); the delete-half of a rename flows through the same queue.
 */
export class MutationQueue {
	private data: MutationData = { deletes: [] };

	constructor(
		private readonly load: () => Promise<MutationData | null>,
		private readonly save: (data: MutationData) => Promise<void>,
	) {}

	async init(): Promise<void> {
		const loaded = await this.load();
		this.data = { deletes: loaded?.deletes ?? [] };
	}

	/** Queue a delete for `path` (no-op if already queued — deletes are idempotent by identity). */
	enqueueDelete(path: string): void {
		if (!this.data.deletes.includes(path)) this.data.deletes.push(path);
	}

	/** Drop `path` from the queue (its delete landed, or was superseded by a local re-creation). */
	dequeue(path: string): void {
		this.data.deletes = this.data.deletes.filter((p) => p !== path);
	}

	/** The currently-queued delete paths (a copy — mutate via enqueue/dequeue). */
	list(): string[] {
		return [...this.data.deletes];
	}

	async persist(): Promise<void> {
		await this.save(this.data);
	}

	/** Wipe the queue (on disconnect) so a stale delete can't fire against the next linked vault. */
	async reset(): Promise<void> {
		this.data = { deletes: [] };
		await this.persist();
	}
}
