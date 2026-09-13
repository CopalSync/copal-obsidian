import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
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

/**
 * A pre-upgrade install, built with the very class that built the real ones: the store keyed by the
 * old constant tenant. That produces both halves of the legacy state — the per-note database AND the
 * `copal-index` record under the literal `"vault"` — which a hand-rolled fixture would get subtly
 * wrong.
 */
function legacyStore(): LocalDocStore {
	return new LocalDocStore(() => Promise.resolve(asVaultId("vault")));
}

async function seedLegacyNote(path: string, text: string): Promise<void> {
	const store = legacyStore();
	const { doc, whenLoaded } = store.open(path);
	await whenLoaded;
	doc.getText("content").insert(0, text);
	await new Promise((r) => setTimeout(r, 60)); // let y-indexeddb flush
	store.close(path);
	await new Promise((r) => setTimeout(r, 30)); // and let the connection close
}

async function names(): Promise<string[]> {
	return ((await globalThis.indexedDB.databases()) ?? []).map((d) => d.name ?? "");
}

/** What the legacy `copal-index` record still lists, read the way iOS reads it. */
async function legacyIndexRecord(): Promise<string[]> {
	let listed: string[] = [];
	await withoutDatabasesApi(async () => {
		listed = await legacyStore().listPersisted();
	});
	return listed;
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
		await keep.open("mine.md").whenLoaded;
		await seedLegacyNote("theirs.md", "x");

		await purgeLegacyCrdtDocs();

		expect(await names()).toContain("copal:vlt-keep:mine.md");
		expect(await names()).not.toContain("copal:vault:theirs.md");
		await keep.destroy("mine.md");
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
