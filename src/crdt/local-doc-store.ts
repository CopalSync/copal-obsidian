import * as idb from "lib0/indexeddb";
import * as Y from "yjs";
import { DocDb, type DocRecord, mergeRows } from "./doc-db";

/**
 * The Copal vault a local doc belongs to, proven rather than asserted.
 *
 * ⛔ **THIS TYPE EXISTS TO STOP ONE SPECIFIC BUG COMING BACK.** The store keys its storage by vault, and
 * a test has always asserted that shape, but production once passed the literal string `"vault"`, so
 * every install shared one namespace. Obsidian desktop loads every vault window from the same
 * `app://obsidian.md` origin, so two folders linked to different Copal vaults (or different accounts)
 * shared everything: note contents crossed accounts, same-path notes converged into one document, and a
 * disconnect in one folder destroyed the other's history.
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
	// `:` separates the database name's parts, so an id containing one could collide with another
	// vault's namespace. Server-minted ids are `vlt_<uuid>`, so this only fires on something malformed.
	if (raw.includes(":")) throw new Error(`malformed vault id: ${raw}`);
	return raw as VaultId;
}

/** Coalescing window for local updates: one transaction per burst of keystrokes, not per keystroke. */
const WRITE_COALESCE_MS = 250;
/** Compact a note's log once it grows past this many rows. */
const COMPACT_ROWS = 500;
/** Compact on close when a note is cheap to tidy, so a reopen is one row rather than dozens. */
const COMPACT_ON_CLOSE_ROWS = 50;

/**
 * Origin tag for updates this store applies while loading a doc, so its own writes never come back
 * through the update handler and get re-persisted.
 */
const PERSISTENCE_ORIGIN = Object.freeze({ persistence: true });
/** Ops that arrived from the server are not local work, so they must not mark a note dirty. */
const SERVER_ORIGIN = "server";

interface Entry {
	doc: Y.Doc;
	whenLoaded: Promise<void>;
	record: DocRecord;
	unsubscribe: () => void;
	/** Updates awaiting their coalesced write. */
	pending: Uint8Array[];
	timer: ReturnType<typeof setTimeout> | undefined;
	/** In-flight flush, so `close`/`flush` can await the write actually landing. */
	writing: Promise<void>;
	dirtied: boolean;
}

/**
 * Per-note persistent local Y.Doc store — the local-first spine. Every note's Yjs update log lives in
 * **one IndexedDB database per vault** (`copal:${vaultId}`, two stores keyed by path), so an edit —
 * offline, closed, or active — is an op on shared history that survives a reload with no server round
 * trip. This makes the client symmetric with the server DO, which persists the same per-note log; the
 * `.md` file is the doc's projection.
 *
 * Replaces one-database-per-note (P2). That scheme never closed or evicted anything, so a large vault
 * accumulated a database and an open connection per note, and listing them needed
 * `indexedDB.databases()` — which WebKit does not implement, so iOS needed a second index database to
 * fall back on. One database per vault removes all three problems at once: `paths()` is a `getAllKeys`,
 * and desktop and iOS run the same code.
 *
 * Writes are coalesced in a {@link WRITE_COALESCE_MS} window and merged with `Y.mergeUpdates`, so a burst
 * of keystrokes is one transaction. Logs compact at {@link COMPACT_ROWS}, and on close past
 * {@link COMPACT_ON_CLOSE_ROWS}.
 */
export class LocalDocStore {
	private readonly entries = new Map<string, Entry>();
	/** In-flight teardowns, so `open` can wait one out instead of racing it. Keyed by path. */
	private readonly closing = new Map<string, Promise<void>>();
	private dbPromise: Promise<DocDb> | undefined;
	/** The vault the open database belongs to, set and cleared with `dbPromise`. */
	private openFor: VaultId | undefined;

	constructor(private readonly vaultIdProvider: VaultIdProvider) {}

	/**
	 * The database of the vault linked NOW, with the one-time import from the per-note scheme already
	 * run.
	 *
	 * ⛔ **The id is read on every call, never memoised.** It used to be resolved once for the life of the
	 * store, and `main.ts` keeps one store for the whole session while `resetLocalVaultState` wipes it
	 * with the OLD vault still linked. So the wipe pinned the old id, and after a relink to another
	 * account's vault every pulled note was persisted under the old one, where a later merge reconcile
	 * for that vault found them and uploaded them into it. `closeAll` and `destroyAll` release the
	 * database, so the next call opens whichever vault is linked by then.
	 *
	 * If the link changes while a database is open, this refuses rather than write under a vault the
	 * folder no longer belongs to: the `asVaultId` rule, that persisting a note under the wrong vault is
	 * worse than not persisting it at all.
	 */
	private async database(): Promise<DocDb> {
		const vaultId = await this.vaultIdProvider();
		if (this.dbPromise === undefined) {
			this.openFor = vaultId;
			this.dbPromise = (async () => {
				const db = await DocDb.open(vaultId);
				await importLegacyDatabases(db, vaultId);
				return db;
			})().catch((err: unknown) => {
				this.dbPromise = undefined;
				this.openFor = undefined;
				throw err;
			});
		} else if (this.openFor !== vaultId) {
			throw new Error(
				`linked vault changed from ${this.openFor} to ${vaultId}; close the local store first`,
			);
		}
		return this.dbPromise;
	}

	/** Open (or reuse) a note's persisted local Y.Doc. `whenLoaded` resolves once IndexedDB rehydrates it. */
	open(path: string): { doc: Y.Doc; whenLoaded: Promise<void> } {
		const existing = this.entries.get(path);
		if (existing) return { doc: existing.doc, whenLoaded: existing.whenLoaded };
		const doc = new Y.Doc();
		// ⚠️ Wait out any teardown still running for this path, or a re-open races it.
		const settled = this.closing.get(path) ?? Promise.resolve();
		const entry: Entry = {
			doc,
			whenLoaded: Promise.resolve(),
			record: { path, rows: 0, seq: 0, dirty: 0, serverSv: null, fileHash: "", updatedAt: 0 },
			unsubscribe: () => undefined,
			pending: [],
			timer: undefined,
			writing: Promise.resolve(),
			dirtied: false,
		};
		entry.whenLoaded = (async () => {
			await settled;
			const db = await this.database();
			const loaded = await db.load(path);
			entry.record = loaded.record;
			// One transaction, and tagged with our own origin so the handler below does not re-persist it.
			if (loaded.updates.length > 0) {
				doc.transact(() => {
					for (const update of loaded.updates) Y.applyUpdate(doc, update, PERSISTENCE_ORIGIN);
				}, PERSISTENCE_ORIGIN);
			}
			const handler = (update: Uint8Array, origin: unknown): void => {
				if (origin === PERSISTENCE_ORIGIN) return; // our own load, coming back around
				entry.pending.push(update);
				if (origin !== SERVER_ORIGIN) entry.dirtied = true;
				this.arm(path, entry);
			};
			doc.on("update", handler);
			entry.unsubscribe = () => doc.off("update", handler);
		})();
		void entry.whenLoaded.catch(() => undefined); // surfaced to callers that await it
		this.entries.set(path, entry);
		return { doc, whenLoaded: entry.whenLoaded };
	}

	/** Arm (or re-arm) the coalescing window. A burst of keystrokes becomes one write. */
	private arm(path: string, entry: Entry): void {
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			entry.writing = entry.writing.then(() => this.flushEntry(path, entry)).catch(() => undefined);
		}, WRITE_COALESCE_MS);
	}

	private async flushEntry(path: string, entry: Entry): Promise<void> {
		if (entry.pending.length === 0) return;
		const merged = mergeRows(entry.pending.splice(0));
		const dirty = entry.dirtied;
		entry.dirtied = false;
		const db = await this.database();
		entry.record = await db.append(path, merged, dirty ? { dirty: 1 } : {});
		if (entry.record.rows >= COMPACT_ROWS) await this.compact(path, entry);
	}

	private async compact(path: string, entry: Entry): Promise<void> {
		const db = await this.database();
		entry.record = await db.compact(path, Y.encodeStateAsUpdate(entry.doc));
	}

	/** Land any coalesced writes for `path` now. */
	async flush(path: string): Promise<void> {
		const entry = this.entries.get(path);
		if (!entry) return;
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		await entry.whenLoaded.catch(() => undefined);
		entry.writing = entry.writing.then(() => this.flushEntry(path, entry));
		await entry.writing;
	}

	/** Land every coalesced write. Used by teardown before the database closes. */
	async flushAll(): Promise<void> {
		await Promise.all([...this.entries.keys()].map((path) => this.flush(path)));
	}

	/** What is known about a note without loading it. */
	async record(path: string): Promise<DocRecord> {
		const entry = this.entries.get(path);
		if (entry) {
			await entry.whenLoaded.catch(() => undefined);
			return entry.record;
		}
		return (await this.database()).record(path);
	}

	/** Patch a note's metadata (the server's state vector, the dirty hint, the file hash). */
	async setMeta(
		path: string,
		patch: { serverSv?: Uint8Array | null; dirty?: boolean; fileHash?: string },
	): Promise<void> {
		const db = await this.database();
		const record = await db.patch(path, {
			...(patch.serverSv === undefined
				? {}
				: { serverSv: patch.serverSv === null ? null : toBuffer(patch.serverSv) }),
			...(patch.dirty === undefined ? {} : { dirty: patch.dirty ? 1 : 0 }),
			...(patch.fileHash === undefined ? {} : { fileHash: patch.fileHash }),
		});
		const entry = this.entries.get(path);
		if (entry) entry.record = record;
	}

	/** Paths currently open in memory. */
	list(): string[] {
		return [...this.entries.keys()];
	}

	/**
	 * Every note with persisted local state, open or not. One `getAllKeys` — which is what replaced
	 * enumerating `indexedDB.databases()` and the separate iOS index database it needed.
	 */
	async listPersisted(): Promise<string[]> {
		return (await this.database()).paths();
	}

	/** Notes holding ops the server may not have, read from the index without loading any document. */
	async listDirty(): Promise<string[]> {
		return (await this.database()).dirtyPaths();
	}

	/** Stop holding a note in memory (its stored data is kept for next open). */
	close(path: string): void {
		const entry = this.entries.get(path);
		if (!entry) return;
		this.entries.delete(path);
		const done = (async () => {
			await entry.whenLoaded.catch(() => undefined);
			if (entry.timer !== undefined) clearTimeout(entry.timer);
			entry.timer = undefined;
			await this.flushEntry(path, entry).catch(() => undefined);
			// Tidy a log that is cheap to tidy, so the next open is one row rather than dozens.
			if (entry.record.rows > COMPACT_ON_CLOSE_ROWS) {
				await this.compact(path, entry).catch(() => undefined);
			}
			entry.unsubscribe();
			entry.doc.destroy();
		})();
		this.closing.set(path, done);
		void done.then(() => {
			if (this.closing.get(path) === done) this.closing.delete(path);
		});
	}

	/** Close every open note and the database itself. */
	async closeAll(): Promise<void> {
		// oxlint-disable-next-line unicorn/no-useless-spread -- iterating a SNAPSHOT: the body mutates this map
		for (const path of [...this.entries.keys()]) this.close(path);
		await Promise.all(this.closing.values());
		if (this.dbPromise) {
			const db = await this.dbPromise.catch(() => undefined);
			db?.close();
			this.dbPromise = undefined;
			this.openFor = undefined;
		}
	}

	/**
	 * Rename a note's persisted local doc, **preserving its Yjs lineage** (same struct client ids and
	 * clocks) rather than starting a fresh doc — symmetric with the server-side move.
	 */
	async rename(oldPath: string, newPath: string): Promise<void> {
		const from = this.open(oldPath);
		await from.whenLoaded;
		const to = this.open(newPath);
		await to.whenLoaded;
		Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc)); // carry every struct
		const carried = await this.record(oldPath);
		await this.flush(newPath);
		await this.setMeta(newPath, { fileHash: carried.fileHash, dirty: carried.dirty === 1 });
		await this.destroy(oldPath);
	}

	/** Permanently delete a note's persisted local data. */
	async destroy(path: string): Promise<void> {
		this.close(path);
		await this.closing.get(path)?.catch(() => undefined);
		await (await this.database()).remove(path);
	}

	/**
	 * Wipe every persisted local doc for this vault (a clean disconnect). The database that is OPEN, if
	 * one is, even when the link has moved on since: teardown must not be refused by the check in
	 * `database()`, or a disconnect after an external relink could never finish.
	 */
	async destroyAll(): Promise<void> {
		// oxlint-disable-next-line unicorn/no-useless-spread -- iterating a SNAPSHOT: the body mutates this map
		for (const path of [...this.entries.keys()]) this.close(path);
		await Promise.all(this.closing.values());
		const db = await (this.dbPromise ?? this.database());
		await db.destroy();
		this.dbPromise = undefined;
		this.openFor = undefined;
	}
}

function toBuffer(u8: Uint8Array): ArrayBuffer {
	const buf = new ArrayBuffer(u8.byteLength);
	new Uint8Array(buf).set(u8);
	return buf;
}

/** y-indexeddb's store name, for reading the databases this replaces. */
const LEGACY_UPDATES_STORE = "updates";
/** The iOS-only path index the old scheme needed because WebKit has no `indexedDB.databases()`. */
const LEGACY_INDEX_DB = "copal-index";
const LEGACY_INDEX_STORE = "paths";
/** Import in pages, so a large vault does not hold every legacy doc at once. */
const IMPORT_PAGE = 50;

/**
 * One-time import from the per-note databases (`copal:${vaultId}:${path}`) into this vault's single
 * database, then delete them. An importer that removes its inputs, so it cannot run twice.
 *
 * Runs only when the new `docs` store is empty and something legacy exists, so a normal start pays one
 * `getAllKeys`. Legacy paths come from `indexedDB.databases()` on desktop and from the old `copal-index`
 * record on iOS — which is the whole reason that database existed.
 */
async function importLegacyDatabases(db: DocDb, vaultId: string): Promise<void> {
	if ((await db.paths()).length > 0) return; // already migrated (or a fresh install that has synced)
	const prefix = `copal:${vaultId}:`;
	const paths = await legacyPaths(prefix, vaultId);
	if (paths.length === 0) return;
	for (let i = 0; i < paths.length; i += IMPORT_PAGE) {
		const page = paths.slice(i, i + IMPORT_PAGE);
		// oxlint-disable-next-line no-await-in-loop -- paged on purpose: bounded memory over speed
		await Promise.all(page.map((path) => importOne(db, `${prefix}${path}`, path)));
	}
	await idb.deleteDB(LEGACY_INDEX_DB).catch(() => undefined);
}

async function legacyPaths(prefix: string, vaultId: string): Promise<string[]> {
	if (typeof globalThis.indexedDB?.databases === "function") {
		const dbs = (await globalThis.indexedDB.databases()) ?? [];
		return dbs
			.map((d) => d.name ?? "")
			.filter((n) => n.startsWith(prefix))
			.map((n) => n.slice(prefix.length));
	}
	try {
		const index = await idb.openDB(LEGACY_INDEX_DB, (raw) => {
			raw.createObjectStore(LEGACY_INDEX_STORE);
		});
		const [store] = idb.transact(index, [LEGACY_INDEX_STORE], "readonly");
		if (!store) return [];
		const record = (await idb.get(store, vaultId)) as unknown as string[] | undefined;
		index.close();
		return record ?? [];
	} catch {
		return []; // no index, nothing to import
	}
}

async function importOne(db: DocDb, legacyName: string, path: string): Promise<void> {
	try {
		const legacy = await idb.openDB(legacyName, (raw) => {
			// Created only if it does not exist, which means there was nothing to import.
			raw.createObjectStore(LEGACY_UPDATES_STORE, { autoIncrement: true });
		});
		const [store] = idb.transact(legacy, [LEGACY_UPDATES_STORE], "readonly");
		const rows = store ? ((await idb.getAll(store)) as ArrayBuffer[]) : [];
		legacy.close();
		if (rows.length > 0) {
			await db.append(path, mergeRows(rows.map((b) => new Uint8Array(b))), { dirty: 1 });
		}
		await idb.deleteDB(legacyName);
	} catch {
		/* a legacy database we cannot read is left alone rather than failing the whole import */
	}
}
