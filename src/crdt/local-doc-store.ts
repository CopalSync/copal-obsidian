import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

interface Entry {
	doc: Y.Doc;
	provider: IndexeddbPersistence;
	whenLoaded: Promise<void>;
}

/**
 * Per-note persistent local Y.Doc store — the local-first spine. Each note's Yjs update log is persisted
 * client-side in IndexedDB (via y-indexeddb), so an edit — offline, closed, or active — is an op on shared
 * history that survives a reload with **no server round-trip**. This makes the client symmetric with the
 * server DO (which persists the same per-note log); the `.md` file is this doc's projection. Keyed
 * `copal:${tenant}:${path}` so tenants are isolated. IndexedDB is a browser global present in Obsidian's
 * Electron renderer and the mobile Capacitor webview (tests shim it with `fake-indexeddb`).
 */
export class LocalDocStore {
	private readonly entries = new Map<string, Entry>();
	private readonly index: PersistedIndex;

	constructor(private readonly tenant: string) {
		this.index = new PersistedIndex(tenant);
	}

	/** Open (or reuse) a note's persisted local Y.Doc. `whenLoaded` resolves once IndexedDB rehydrates it. */
	open(path: string): { doc: Y.Doc; whenLoaded: Promise<void> } {
		const existing = this.entries.get(path);
		if (existing) return { doc: existing.doc, whenLoaded: existing.whenLoaded };
		const doc = new Y.Doc();
		const provider = new IndexeddbPersistence(this.key(path), doc);
		const whenLoaded = provider.whenSynced.then(() => undefined);
		this.entries.set(path, { doc, provider, whenLoaded });
		void this.index.add(path); // record it so `listPersisted()` is correct even where `databases()` is absent
		return { doc, whenLoaded };
	}

	/**
	 * Rename a note's persisted local doc `oldPath` → `newPath`, **preserving its Yjs lineage** (same struct
	 * client IDs + clocks) rather than starting a fresh doc. Transfers the full state into a new-keyed
	 * persisted doc, then destroys the old — so a rename keeps the note's CRDT history locally (symmetric with
	 * the server-side move). The in-memory new entry carries the lineage immediately; y-indexeddb flushes it.
	 * The persisted index follows automatically: `open(newPath)` adds it, `destroy(oldPath)` removes the old.
	 */
	async rename(oldPath: string, newPath: string): Promise<void> {
		const from = this.open(oldPath);
		await from.whenLoaded; // the old lineage must be rehydrated before we copy it
		const to = this.open(newPath);
		await to.whenLoaded;
		Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc)); // carry every struct (same client IDs/clocks)
		await this.destroy(oldPath);
	}

	/** Stop holding a note in memory + persisting it (the stored data is kept for next open). */
	close(path: string): void {
		const entry = this.entries.get(path);
		if (!entry) return;
		void entry.provider.destroy(); // closes the idb connection; data is retained
		entry.doc.destroy();
		this.entries.delete(path);
	}

	/** Permanently delete a note's persisted local data (on a confirmed remote delete / bring-existing purge).
	 *  Closes any open connection, then **awaits** the actual database deletion — `y-indexeddb`'s `clearData()`
	 *  fires `deleteDB` without awaiting it, so relying on it leaves the (emptied) DB visible to
	 *  `listPersisted()` for a beat, and a racing reconcile could re-push it. Awaiting makes `destroy()`
	 *  authoritative: the doc is gone from `listPersisted()` the moment this resolves. */
	async destroy(path: string): Promise<void> {
		const entry = this.entries.get(path);
		if (entry) {
			await entry.provider.destroy(); // close the IndexedDB connection so the delete isn't blocked
			entry.doc.destroy();
			this.entries.delete(path);
		}
		await this.deleteDb(path);
		await this.index.remove(path); // keep the persisted index in step with the actual DB deletion
	}

	/** Permanently delete ALL of this store's persisted docs (a clean disconnect). Enumerates the persisted
	 *  set ∪ any open entries so nothing is missed, and awaits each deletion. */
	async destroyAll(): Promise<void> {
		const paths = new Set([...(await this.listPersisted()), ...this.entries.keys()]);
		await Promise.all([...paths].map((p) => this.destroy(p)));
		await this.index.clear(); // belt-and-suspenders: nothing should remain, but never leave stale entries
	}

	/** Delete the whole per-note database, resolving once done (or if unavailable). */
	private deleteDb(path: string): Promise<void> {
		const idb = globalThis.indexedDB;
		if (!idb?.deleteDatabase) return Promise.resolve();
		return new Promise((resolve) => {
			const req = idb.deleteDatabase(this.key(path));
			req.onsuccess = () => resolve();
			req.onerror = () => resolve();
			req.onblocked = () => resolve(); // an open connection elsewhere; the delete completes when it closes
		});
	}

	/** Paths currently open in memory. */
	list(): string[] {
		return [...this.entries.keys()];
	}

	/**
	 * Every note that already has a **persisted** local doc (in IndexedDB), whether or not it's open. Lets
	 * reconcile first-import only the notes the client has never seen — so a steady-state reload syncs
	 * nothing.
	 *
	 * `indexedDB.databases()` is the ground truth where it exists (Chromium/Electron desktop), so we return
	 * it AND heal the self-owned index to match (this also migrates installs that predate the index). On
	 * iOS/WebKit `databases()` is **not implemented**, so we fall back to the maintained index — which
	 * `open()`/`destroy()`/`rename()` keep current — instead of degrading to `[]` (which made reconcile
	 * needlessly re-sync every note on iOS).
	 */
	async listPersisted(): Promise<string[]> {
		if (typeof globalThis.indexedDB?.databases === "function") {
			const enumerated = await this.enumerateDatabases();
			await this.index.replace(enumerated); // heal / migrate the index toward ground truth
			return enumerated;
		}
		return this.index.list(); // no databases() (iOS) → the maintained index is authoritative
	}

	/** Persisted paths derived from `indexedDB.databases()` (desktop only). */
	private async enumerateDatabases(): Promise<string[]> {
		const prefix = `copal:${this.tenant}:`;
		const dbs = (await globalThis.indexedDB.databases()) ?? [];
		return dbs
			.map((d) => d.name ?? "")
			.filter((n) => n.startsWith(prefix))
			.map((n) => n.slice(prefix.length));
	}

	private key(path: string): string {
		return `copal:${this.tenant}:${path}`;
	}
}

/**
 * A tiny persisted set of the note paths that HAVE a local doc — the iOS-safe replacement for enumerating
 * `indexedDB.databases()` (which iOS/WebKit does not implement). One dedicated IndexedDB database
 * (`copal-index`), object store `paths` keyed by tenant → the array of persisted paths. All operations run
 * through a serial queue so concurrent add/remove can't lose an update (read-modify-write races). Every
 * method fails **open** (errors resolve to a no-op / empty list), so a broken index never blocks the store
 * or throws into the sync engine — the caller's `databases()` path still works on desktop.
 */
class PersistedIndex {
	private static readonly DB = "copal-index";
	private static readonly STORE = "paths";
	private chain: Promise<unknown> = Promise.resolve();
	private dbPromise: Promise<IDBDatabase> | undefined;

	constructor(private readonly tenant: string) {}

	add(path: string): Promise<void> {
		return this.mutate((set) => set.add(path));
	}

	remove(path: string): Promise<void> {
		return this.mutate((set) => set.delete(path));
	}

	clear(): Promise<void> {
		return this.enqueue(() => this.write([]));
	}

	/** Overwrite the whole set (used to heal/migrate toward `databases()` ground truth on desktop). */
	replace(paths: string[]): Promise<void> {
		return this.enqueue(() => this.write([...new Set(paths)]));
	}

	list(): Promise<string[]> {
		return this.enqueue(() => this.read());
	}

	private mutate(fn: (set: Set<string>) => void): Promise<void> {
		return this.enqueue(async () => {
			try {
				const set = new Set(await this.read());
				fn(set);
				await this.write([...set]);
			} catch {
				/* fail-open — a broken index must never throw into the store */
			}
		});
	}

	/** Serialize every operation so read-modify-write is atomic within this instance. Never rejects. */
	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		const run = this.chain.then(op, op);
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private read(): Promise<string[]> {
		return this.tx("readonly", (store) => store.get(this.tenant)).then(
			(v) => (Array.isArray(v) ? (v as string[]) : []),
			() => [],
		);
	}

	private write(paths: string[]): Promise<void> {
		return this.tx("readwrite", (store) => store.put(paths, this.tenant)).then(
			() => undefined,
			() => undefined,
		);
	}

	private tx<T>(
		mode: IDBTransactionMode,
		fn: (store: IDBObjectStore) => IDBRequest<T>,
	): Promise<T> {
		return this.db().then(
			(db) =>
				new Promise<T>((resolve, reject) => {
					const req = fn(
						db.transaction(PersistedIndex.STORE, mode).objectStore(PersistedIndex.STORE),
					);
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error ?? new Error("index request failed"));
				}),
		);
	}

	private db(): Promise<IDBDatabase> {
		if (!this.dbPromise) {
			this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
				const idb = globalThis.indexedDB;
				if (!idb) {
					reject(new Error("no indexedDB"));
					return;
				}
				const req = idb.open(PersistedIndex.DB, 1);
				req.onupgradeneeded = () => {
					if (!req.result.objectStoreNames.contains(PersistedIndex.STORE)) {
						req.result.createObjectStore(PersistedIndex.STORE);
					}
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error ?? new Error("index open failed"));
			}).catch((err) => {
				this.dbPromise = undefined; // don't cache a failed open — retry next time
				throw err;
			});
		}
		return this.dbPromise;
	}
}
