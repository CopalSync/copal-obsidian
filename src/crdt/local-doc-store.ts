import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

interface Entry {
	doc: Y.Doc;
	/**
	 * Resolves once the y-indexeddb provider exists. Deferred, because the database NAME needs the
	 * linked vault id and that is an async read of `data.json`.
	 */
	provider: Promise<IndexeddbPersistence>;
	whenLoaded: Promise<void>;
}

/**
 * The Copal vault a local doc belongs to, proven rather than asserted.
 *
 * ⛔ **THIS TYPE EXISTS TO STOP ONE SPECIFIC BUG COMING BACK.** The store has always keyed databases
 * `copal:${tenant}:${path}` and a test has always asserted that shape, but production passed the
 * literal string `"vault"` for the tenant, so every install shared one namespace. Obsidian desktop
 * loads every vault window from the same `app://obsidian.md` origin, so two folders linked to
 * different Copal vaults (or different accounts) shared every database and the `copal-index` record:
 * note contents crossed accounts, same-path notes converged into one document, and a disconnect in
 * one folder destroyed the other's history.
 *
 * A branded type makes that regression a **compile** error rather than something review has to catch.
 * `new LocalDocStore("vault")` does not typecheck, and CI runs `pnpm typecheck` across the workspace.
 */
export type VaultId = string & { readonly __vaultId: unique symbol };

/** How the store learns its vault. Async because the id lives in `data.json`, and a provider rather
 *  than a value because a folder can be unlinked at construction and linked later. */
export type VaultIdProvider = () => Promise<VaultId>;

/**
 * The only way to make a `VaultId`. Throws rather than inventing a fallback: a default tenant is
 * precisely the bug above, and silently persisting a note under the wrong vault is worse than not
 * persisting it at all.
 */
export function asVaultId(raw: string | undefined): VaultId {
	if (raw === undefined || raw.trim() === "") {
		throw new Error("no linked Copal vault: this folder has nothing to persist against");
	}
	// `:` separates the key's three parts, so an id containing one could be read back as a path
	// prefix by `enumerateDatabases`. Server-minted ids are `vlt_<uuid>`, so this only ever fires on
	// something malformed.
	if (raw.includes(":")) throw new Error(`malformed vault id: ${raw}`);
	return raw as VaultId;
}

/**
 * Per-note persistent local Y.Doc store — the local-first spine. Each note's Yjs update log is persisted
 * client-side in IndexedDB (via y-indexeddb), so an edit — offline, closed, or active — is an op on shared
 * history that survives a reload with **no server round-trip**. This makes the client symmetric with the
 * server DO (which persists the same per-note log); the `.md` file is this doc's projection. Keyed
 * `copal:${vaultId}:${path}` so vaults are isolated — see `VaultId` for why that is load-bearing and
 * why it is a branded type. IndexedDB is a browser global present in Obsidian's Electron renderer and
 * the mobile Capacitor webview (tests shim it with `fake-indexeddb`).
 */
export class LocalDocStore {
	private readonly entries = new Map<string, Entry>();
	/** In-flight teardowns, so `open` can wait one out instead of racing it. Keyed by path. */
	private readonly closing = new Map<string, Promise<void>>();
	private readonly index: PersistedIndex;
	private vaultIdPromise: Promise<VaultId> | undefined;

	constructor(private readonly vaultIdProvider: VaultIdProvider) {
		this.index = new PersistedIndex(() => this.vaultId());
	}

	/**
	 * The vault id, resolved once.
	 *
	 * ⚠️ A FAILURE IS NOT CACHED, the same way `PersistedIndex.db()` does not cache a failed open: an
	 * unlinked folder throws here, and it can be linked a moment later without a reload.
	 */
	private vaultId(): Promise<VaultId> {
		this.vaultIdPromise ??= this.vaultIdProvider().catch((err: unknown) => {
			this.vaultIdPromise = undefined;
			throw err;
		});
		return this.vaultIdPromise;
	}

	/** Open (or reuse) a note's persisted local Y.Doc. `whenLoaded` resolves once IndexedDB rehydrates it. */
	open(path: string): { doc: Y.Doc; whenLoaded: Promise<void> } {
		const existing = this.entries.get(path);
		if (existing) return { doc: existing.doc, whenLoaded: existing.whenLoaded };
		const doc = new Y.Doc();
		// ⚠️ Wait out any teardown still running for this path. `close()` is fire-and-forget, so a re-open
		// that ignored it would build a second `IndexeddbPersistence` on the same database name while the
		// first was still calling `db.close()` — and the new provider's `whenSynced` can then never
		// resolve, hanging every caller that awaits `whenLoaded`. Latent since `close()` existed; batched
		// syncing exercises it constantly, because a finished page releases every note it synced.
		const settled = this.closing.get(path) ?? Promise.resolve();
		// Synchronous signature, async key: the caller gets its `Y.Doc` immediately (editors bind to it
		// before anything is loaded) while the database name waits on the vault id.
		const provider = settled
			.then(() => this.key(path))
			.then((name) => new IndexeddbPersistence(name, doc));
		void provider.catch(() => {}); // the real failure surfaces through `whenLoaded`, which callers await
		const whenLoaded = provider.then((p) => p.whenSynced).then(() => undefined);
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
		this.entries.delete(path);
		// Fire-and-forget as before, but the provider may not exist yet (its name needed the vault id).
		// Close it FIRST where it does, so y-indexeddb never flushes into a destroyed doc.
		// The promise is RECORDED so a re-open of this path can wait it out — see `open`.
		const done = entry.provider
			.then(
				(p) => p.destroy().then(() => entry.doc.destroy()),
				() => entry.doc.destroy(), // never opened; nothing to close
			)
			.catch(() => undefined);
		this.closing.set(path, done);
		void done.then(() => {
			if (this.closing.get(path) === done) this.closing.delete(path);
		});
	}

	/** Permanently delete a note's persisted local data (on a confirmed remote delete / bring-existing purge).
	 *  Closes any open connection, then **awaits** the actual database deletion — `y-indexeddb`'s `clearData()`
	 *  fires `deleteDB` without awaiting it, so relying on it leaves the (emptied) DB visible to
	 *  `listPersisted()` for a beat, and a racing reconcile could re-push it. Awaiting makes `destroy()`
	 *  authoritative: the doc is gone from `listPersisted()` the moment this resolves. */
	async destroy(path: string): Promise<void> {
		const entry = this.entries.get(path);
		if (entry) {
			this.entries.delete(path);
			try {
				await (await entry.provider).destroy(); // close the connection so the delete isn't blocked
			} catch {
				/* never opened (no vault id): there is no connection to close */
			}
			entry.doc.destroy();
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
	private async deleteDb(path: string): Promise<void> {
		const idb = globalThis.indexedDB;
		if (!idb?.deleteDatabase) return;
		let name: string;
		try {
			name = await this.key(path);
		} catch {
			return; // no vault id, so no database of ours can exist under one
		}
		await new Promise<void>((resolve) => {
			const req = idb.deleteDatabase(name);
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
		const prefix = `copal:${await this.vaultId()}:`;
		const dbs = (await globalThis.indexedDB.databases()) ?? [];
		return dbs
			.map((d) => d.name ?? "")
			.filter((n) => n.startsWith(prefix))
			.map((n) => n.slice(prefix.length));
	}

	private async key(path: string): Promise<string> {
		return `copal:${await this.vaultId()}:${path}`;
	}
}

/**
 * A tiny persisted set of the note paths that HAVE a local doc — the iOS-safe replacement for enumerating
 * `indexedDB.databases()` (which iOS/WebKit does not implement). One dedicated IndexedDB database
 * (`copal-index`), object store `paths` keyed by VAULT ID → the array of persisted paths. All operations run
 * through a serial queue so concurrent add/remove can't lose an update (read-modify-write races). Every
 * method fails **open** (errors resolve to a no-op / empty list), so a broken index never blocks the store
 * or throws into the sync engine — the caller's `databases()` path still works on desktop.
 */
class PersistedIndex {
	private static readonly DB = "copal-index";
	private static readonly STORE = "paths";
	private chain: Promise<unknown> = Promise.resolve();
	private dbPromise: Promise<IDBDatabase> | undefined;

	/**
	 * ⚠️ The `copal-index` DATABASE is shared by every vault in the origin; the vault id is the record
	 * KEY inside it. That is why scoping this key is enough, and why passing a constant meant two
	 * different vaults read and wrote each other's path list.
	 */
	constructor(private readonly vaultId: () => Promise<VaultId>) {}

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
		return this.tx("readonly", (store, key) => store.get(key)).then(
			(v) => (Array.isArray(v) ? (v as string[]) : []),
			() => [],
		);
	}

	private write(paths: string[]): Promise<void> {
		return this.tx("readwrite", (store, key) => store.put(paths, key)).then(
			() => undefined,
			() => undefined,
		);
	}

	/** Resolves the record key (the vault id) as part of the transaction, so an unlinked folder fails
	 *  into the same fail-open paths as a broken database rather than throwing into the store. */
	private async tx<T>(
		mode: IDBTransactionMode,
		fn: (store: IDBObjectStore, key: string) => IDBRequest<T>,
	): Promise<T> {
		const key = await this.vaultId();
		const db = await this.db();
		return new Promise<T>((resolve, reject) => {
			const req = fn(
				db.transaction(PersistedIndex.STORE, mode).objectStore(PersistedIndex.STORE),
				key,
			);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error ?? new Error("index request failed"));
		});
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
