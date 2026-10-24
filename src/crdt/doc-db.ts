import * as idb from "lib0/indexeddb";
import * as Y from "yjs";

/**
 * One IndexedDB database per linked Copal vault, holding every note's Yjs update log — replacing the
 * old one-database-per-note scheme (P2).
 *
 * ⛔ **The database is named `copal:${vaultId}`, NOT `copal`, and that is not cosmetic.** Every Obsidian
 * window loads from the same `app://obsidian.md` origin, so a database called `copal` would be shared by
 * two folders linked to different Copal vaults or different accounts — and stores keyed by note path
 * would then collide exactly as N2 did: note contents crossing accounts, same-path notes converging into
 * one document, and a disconnect in one folder destroying the other's history. Per-vault naming is what
 * keeps N2 fixed while still collapsing N databases into one. See `VaultId` for the rest of that story.
 *
 * Two stores:
 *
 * - **`updates`** — out-of-line keys `[path, seq]`, value = one Yjs update. A note's log is the key range
 *   `[path, 0] … [path, ∞]`, so loading it is one `getAll` and dropping it is one `delete(range)`.
 * - **`docs`** — in-line key `path`, value = {@link DocRecord}. Everything the client needs to know about
 *   a note WITHOUT loading its doc: how many rows it has, whether the server is behind, the server's last
 *   state vector, and the hash of what we last saw on disk.
 *
 * ⚠️ `dirty` is stored as `0 | 1` rather than a boolean because **a boolean is not a valid IndexedDB
 * key**, and this field is indexed so `listDirty()` does not have to read every note's record.
 */
const UPDATES = "updates";
const DOCS = "docs";
const DIRTY_INDEX = "dirty";

/** What is known about a note without loading its document. */
export interface DocRecord {
	path: string;
	/** Rows in the `updates` log — drives compaction without counting them. */
	rows: number;
	/** Next `seq` to write for this path. */
	seq: number;
	/** 1 when this note holds ops the server may not have. Indexed; see the note above on the type. */
	dirty: 0 | 1;
	/** The server's state vector at the last successful exchange, so the next push is a diff. */
	serverSv: ArrayBuffer | null;
	/**
	 * Hash of the `.md` as this client last read or wrote it.
	 *
	 * ⛔ **This field is what makes eviction safe.** `LocalNote.lastHash` used to be in-memory only, so a
	 * doc that was closed and reopened reported `fileStateUnknown()` — and `adoptUnseenFileEdits` reads
	 * that as "the file may hold an edit the doc has not seen", merges the file in, and cannot tell which
	 * side is newer. It therefore reverted freshly-pulled remote content on the next sync. P1 had to drop
	 * its per-page doc release for exactly this reason; an LRU that evicts docs without persisting this
	 * would reintroduce the same silent data loss on every eviction.
	 */
	fileHash: string;
	updatedAt: number;
}

const emptyRecord = (path: string): DocRecord => ({
	path,
	rows: 0,
	seq: 0,
	dirty: 0,
	serverSv: null,
	fileHash: "",
	updatedAt: 0,
});

/** A note's persisted log plus its record, as loaded in a single transaction. */
export interface LoadedDoc {
	updates: Uint8Array[];
	record: DocRecord;
}

/**
 * The raw database. Deliberately free of Y.Doc lifecycle, coalescing and eviction — those belong to
 * `LocalDocStore`, which owns the in-memory side. This layer only knows rows and records, which is what
 * makes it testable against `fake-indexeddb` without constructing documents.
 */
export class DocDb {
	private db: IDBDatabase | undefined;

	private constructor(private readonly name: string) {}

	/** Open (creating if needed) the database for one vault. */
	static async open(vaultId: string): Promise<DocDb> {
		const self = new DocDb(`copal:${vaultId}`);
		self.db = await idb.openDB(self.name, (db) => {
			const updates = db.createObjectStore(UPDATES);
			void updates;
			const docs = db.createObjectStore(DOCS, { keyPath: "path" });
			docs.createIndex(DIRTY_INDEX, DIRTY_INDEX);
		});
		return self;
	}

	get databaseName(): string {
		return this.name;
	}

	private get open_(): IDBDatabase {
		if (!this.db) throw new Error("doc database is closed");
		return this.db;
	}

	/** The key range covering one path's whole update log. */
	private static range(path: string): IDBKeyRange {
		return idb.createIDBKeyRangeBound([path, 0], [path, Number.MAX_SAFE_INTEGER], false, false);
	}

	/** Load a note's updates and record together, in one readonly transaction. */
	async load(path: string): Promise<LoadedDoc> {
		const [updatesStore, docsStore] = idb.transact(this.open_, [UPDATES, DOCS], "readonly");
		if (!updatesStore || !docsStore) throw new Error("doc database is closed");
		const [values, record] = await Promise.all([
			idb.getAll(updatesStore, DocDb.range(path)),
			idb.get(docsStore, path),
		]);
		const updates = (values as ArrayBuffer[]).map((b) => new Uint8Array(b));
		return {
			updates,
			record: (record as unknown as DocRecord | undefined) ?? emptyRecord(path),
		};
	}

	/**
	 * Append one update row and advance the record, in a single transaction — so a crash can never leave a
	 * row whose `seq` the record does not know about, or a record claiming rows that are not there.
	 */
	async append(
		path: string,
		update: Uint8Array,
		patch: Partial<DocRecord> = {},
	): Promise<DocRecord> {
		const [updatesStore, docsStore] = idb.transact(this.open_, [UPDATES, DOCS]);
		if (!updatesStore || !docsStore) throw new Error("doc database is closed");
		const current = (await getRecord(docsStore, path)) ?? emptyRecord(path);
		await idb.rtop(updatesStore.put(toBuffer(update), [path, current.seq]));
		const next: DocRecord = {
			...current,
			...patch,
			rows: current.rows + 1,
			seq: current.seq + 1,
			updatedAt: Date.now(),
		};
		await idb.rtop(docsStore.put(next));
		return next;
	}

	/** Replace a note's whole log with one merged row. Keeps the record's metadata. */
	async compact(path: string, merged: Uint8Array): Promise<DocRecord> {
		const [updatesStore, docsStore] = idb.transact(this.open_, [UPDATES, DOCS]);
		if (!updatesStore || !docsStore) throw new Error("doc database is closed");
		const current = (await getRecord(docsStore, path)) ?? emptyRecord(path);
		await idb.rtop(updatesStore.delete(DocDb.range(path)));
		await idb.rtop(updatesStore.put(toBuffer(merged), [path, 0]));
		const next: DocRecord = { ...current, rows: 1, seq: 1, updatedAt: Date.now() };
		await idb.rtop(docsStore.put(next));
		return next;
	}

	/** Patch a note's record without touching its log. */
	async patch(path: string, patch: Partial<DocRecord>): Promise<DocRecord> {
		const [docsStore] = idb.transact(this.open_, [DOCS]);
		if (!docsStore) throw new Error("doc database is closed");
		const current = (await getRecord(docsStore, path)) ?? emptyRecord(path);
		const next: DocRecord = { ...current, ...patch, path, updatedAt: Date.now() };
		await idb.rtop(docsStore.put(next));
		return next;
	}

	async record(path: string): Promise<DocRecord> {
		const [docsStore] = idb.transact(this.open_, [DOCS], "readonly");
		if (!docsStore) throw new Error("doc database is closed");
		return (await getRecord(docsStore, path)) ?? emptyRecord(path);
	}

	/** Drop one note entirely: its log and its record. */
	async remove(path: string): Promise<void> {
		const [updatesStore, docsStore] = idb.transact(this.open_, [UPDATES, DOCS]);
		if (!updatesStore || !docsStore) throw new Error("doc database is closed");
		await idb.rtop(updatesStore.delete(DocDb.range(path)));
		await idb.rtop(docsStore.delete(path));
	}

	/**
	 * Every note with persisted state. One `getAllKeys` on `docs` — which is what replaces enumerating
	 * `indexedDB.databases()`, so desktop and iOS finally run the same code path (WebKit never
	 * implemented `databases()`, which is why a separate `copal-index` database had to exist).
	 */
	async paths(): Promise<string[]> {
		const [docsStore] = idb.transact(this.open_, [DOCS], "readonly");
		if (!docsStore) throw new Error("doc database is closed");
		return (await idb.getAllKeys(docsStore)) as string[];
	}

	/** Notes holding ops the server may not have, without loading a single document. */
	async dirtyPaths(): Promise<string[]> {
		const [docsStore] = idb.transact(this.open_, [DOCS], "readonly");
		if (!docsStore) throw new Error("doc database is closed");
		const index = docsStore.index(DIRTY_INDEX);
		const records = (await idb.rtop(index.getAll(IDBKeyRange.only(1)))) as DocRecord[];
		return records.map((r) => r.path);
	}

	close(): void {
		this.db?.close();
		this.db = undefined;
	}

	/** Delete the whole vault's database (a clean disconnect). */
	async destroy(): Promise<void> {
		this.close();
		await idb.deleteDB(this.name);
	}
}

/**
 * Read one record. lib0's `get` is typed for scalar values only, so the cast lives here once rather
 * than at every call site — IndexedDB itself stores any structured clone.
 */
async function getRecord(store: IDBObjectStore, path: string): Promise<DocRecord | undefined> {
	return (await idb.get(store, path)) as unknown as DocRecord | undefined;
}

/** IndexedDB stores structured clones; an exact-length ArrayBuffer avoids persisting a view's slack. */
function toBuffer(u8: Uint8Array): ArrayBuffer {
	const buf = new ArrayBuffer(u8.byteLength);
	new Uint8Array(buf).set(u8);
	return buf;
}

/** Merge a note's rows into one update — used by compaction and the legacy import. */
export function mergeRows(rows: Uint8Array[]): Uint8Array {
	return rows.length === 1 && rows[0] ? rows[0] : Y.mergeUpdates(rows);
}
