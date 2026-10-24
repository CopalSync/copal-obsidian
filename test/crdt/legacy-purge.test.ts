import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { purgeLegacyCrdtDocs } from "../../src/crdt/legacy-purge";
import { asVaultId, LocalDocStore } from "../../src/crdt/local-doc-store";

type DbEnum = { databases?: (() => Promise<IDBDatabaseInfo[]>) | undefined };

/** Simulate iOS/WebKit, where `indexedDB.databases()` is not implemented, for the duration of `fn`. */
async function withoutDatabasesApi(fn: () => Promise<void>): Promise<void> {
	const idb = globalThis.indexedDB as unknown as DbEnum;
	const orig = idb.databases;
	idb.databases = undefined;
	try {
		await fn();
	} finally {
		idb.databases = orig;
	}
}

const LEGACY_INDEX_DB = "copal-index";
const LEGACY_INDEX_STORE = "paths";

/**
 * A pre-upgrade install, built with the LEGACY writers: one y-indexeddb database per note plus the
 * `copal-index` record, which is exactly what the old store produced.
 *
 * ⚠️ This helper used to build the fixture through `LocalDocStore` itself, on the reasoning that it was
 * "the very class that built the real ones". That was true until P2 rewrote the store to one database
 * per vault — after which the helper produced the NEW shape, and four tests here went on asserting a
 * purge of legacy data that no longer existed. A fixture built through the code under change stops
 * standing for the thing it names, and says nothing when it does.
 */
async function seedLegacyNote(path: string, text: string): Promise<void> {
	const doc = new Y.Doc();
	const provider = new IndexeddbPersistence(`copal:vault:${path}`, doc);
	await provider.whenSynced;
	doc.getText("content").insert(0, text);
	await new Promise((r) => setTimeout(r, 50)); // y-indexeddb writes on its own schedule
	await provider.destroy();
	await addLegacyIndexRecord(path);
}

/** The `copal-index` record the old store maintained, keyed by the constant tenant. */
async function addLegacyIndexRecord(path: string): Promise<void> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const req = globalThis.indexedDB.open(LEGACY_INDEX_DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(LEGACY_INDEX_STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(LEGACY_INDEX_STORE, "readwrite");
		const store = tx.objectStore(LEGACY_INDEX_STORE);
		const read = store.get("vault");
		read.onsuccess = () => {
			const current = (read.result as string[] | undefined) ?? [];
			store.put([...new Set([...current, path])], "vault");
		};
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	db.close();
}

async function names(): Promise<string[]> {
	return ((await globalThis.indexedDB.databases()) ?? []).map((d) => d.name ?? "");
}

/** What the legacy `copal-index` record still lists, read directly rather than through the store. */
async function legacyIndexRecord(): Promise<string[]> {
	try {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = globalThis.indexedDB.open(LEGACY_INDEX_DB, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(LEGACY_INDEX_STORE);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const listed = await new Promise<string[]>((resolve) => {
			const store = db.transaction(LEGACY_INDEX_STORE, "readonly").objectStore(LEGACY_INDEX_STORE);
			const read = store.get("vault");
			read.onsuccess = () => resolve((read.result as string[] | undefined) ?? []);
			read.onerror = () => resolve([]);
		});
		db.close();
		return listed;
	} catch {
		return [];
	}
}

describe("purgeLegacyCrdtDocs", () => {
	it("deletes the constant-tenant databases and forgets the index record", async () => {
		await seedLegacyNote("legacy.md", "old history");
		expect(await names()).toContain("copal:vault:legacy.md");
		expect(await legacyIndexRecord()).toContain("legacy.md");

		const { names: purged, completed } = await purgeLegacyCrdtDocs();

		expect(completed).toBe(true);
		expect(purged).toContain("copal:vault:legacy.md");
		expect(await names()).not.toContain("copal:vault:legacy.md");
		/*
		 * The record matters as much as the database. On iOS it is the ONLY inventory, so a purge that
		 * left it behind would hand reconcile a list of notes whose documents no longer exist, and every
		 * one of them would look like a note deleted on this device.
		 */
		expect(await legacyIndexRecord()).toEqual([]);
	});

	it("leaves a properly keyed vault's documents alone", async () => {
		const keep = new LocalDocStore(() => Promise.resolve(asVaultId("vlt-keep")));
		const mine = keep.open("mine.md");
		await mine.whenLoaded;
		mine.doc.getText("content").insert(0, "keep me");
		await keep.flush("mine.md");
		await seedLegacyNote("theirs.md", "x");

		await purgeLegacyCrdtDocs();

		// The properly keyed vault now lives in ONE database named for it; the purge must not touch it.
		expect(await names()).toContain("copal:vlt-keep");
		expect(await keep.listPersisted()).toContain("mine.md");
		expect(await names()).not.toContain("copal:vault:theirs.md");
		await keep.destroyAll();
	});

	it("is idempotent, so a second load is a no-op rather than a second wipe", async () => {
		await seedLegacyNote("twice.md", "y");
		expect((await purgeLegacyCrdtDocs()).names.length).toBeGreaterThan(0);
		expect((await purgeLegacyCrdtDocs()).names).toEqual([]);
	});

	it("finds the legacy documents on iOS, where databases() does not exist", async () => {
		await seedLegacyNote("ios-legacy.md", "z");
		await withoutDatabasesApi(async () => {
			// The index record is the whole inventory here. Without that branch the purge would report
			// nothing to do on every iPhone and the bug would simply survive there.
			const { names: purged } = await purgeLegacyCrdtDocs();
			expect(purged).toEqual(["copal:vault:ios-legacy.md"]);
		});
		expect(await names()).not.toContain("copal:vault:ios-legacy.md");
	});

	/**
	 * ⛔ The caller awaits this inside `onload`. An IndexedDB open can block indefinitely, and a plugin
	 * that never finishes loading is far worse than a purge that waits for the next launch — so it gives
	 * up, and reports `completed: false` so the caller does not record it as done and skip it forever.
	 */
	it("gives up rather than hanging the plugin load, and does not mark itself done", async () => {
		const real = globalThis.indexedDB;
		// An IndexedDB whose every open hangs, which is what a blocked version change looks like.
		globalThis.indexedDB = {
			databases: () => new Promise(() => {}),
			open: () => ({}) as IDBOpenDBRequest,
			deleteDatabase: () => ({}) as IDBOpenDBRequest,
		} as unknown as IDBFactory;
		try {
			const result = await purgeLegacyCrdtDocs(50);
			expect(result).toEqual({ names: [], completed: false });
		} finally {
			globalThis.indexedDB = real;
		}
	});
});
