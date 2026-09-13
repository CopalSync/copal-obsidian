/**
 * The tenant every install before this change used: a hard-coded literal, never a vault id.
 * @see VaultId in `local-doc-store.ts` for what that cost.
 */
const LEGACY_TENANT = "vault";
const LEGACY_PREFIX = `copal:${LEGACY_TENANT}:`;
const INDEX_DB = "copal-index";
const INDEX_STORE = "paths";

/**
 * Delete every local CRDT document left behind by the constant-tenant era, once, on upgrade.
 *
 * ⛔ **WHY DISCARD RATHER THAN REKEY.** These databases cannot be attributed. In an install that was
 * only ever linked to one vault they are this vault's history and a rekey would preserve them, but in
 * the install this finding is about they are a MIXTURE of two vaults' documents, and nothing
 * distinguishes them: same key, same origin, same index record. Rekeying a commingled set would
 * permanently adopt another account's documents into this vault, which is the bleed itself, made
 * durable.
 *
 * ⚠️ **What is lost is history, not text.** The `.md` file on disk is the projection of its doc, so
 * every note's current content survives untouched. `knownServer` is kept, so the next merge reconcile
 * pulls the server's notes into fresh documents and pushes anything genuinely local-only. What goes is
 * CRDT lineage: struct client ids and clocks, which is what makes a merge of two old offline edits
 * smarter than a last-writer-wins. That is a real cost, accepted deliberately over the alternative.
 *
 * Returns the database names deleted, so the caller can log a real number rather than a claim.
 */
export async function purgeLegacyCrdtDocs(): Promise<string[]> {
	const idb = globalThis.indexedDB;
	if (!idb) return [];

	const names =
		typeof idb.databases === "function"
			? ((await idb.databases().catch(() => [])) ?? [])
					.map((d) => d.name ?? "")
					.filter((n) => n.startsWith(LEGACY_PREFIX))
			: // iOS/WebKit implements no `databases()`, so the legacy index record IS the only inventory
				// that exists. It is keyed by the literal tenant, which is what makes it readable here.
				(await legacyIndexedPaths(idb)).map((p) => `${LEGACY_PREFIX}${p}`);

	for (const name of names) await deleteDatabase(idb, name);
	await forgetLegacyIndexRecord(idb);
	return names;
}

/** The paths the legacy `copal-index` record lists. Fails open: a missing or broken index is simply
 *  an empty inventory, never a thrown error on the load path. */
async function legacyIndexedPaths(idb: IDBFactory): Promise<string[]> {
	try {
		const db = await openIndex(idb);
		const value = await new Promise<unknown>((resolve, reject) => {
			const req = db
				.transaction(INDEX_STORE, "readonly")
				.objectStore(INDEX_STORE)
				.get(LEGACY_TENANT);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error ?? new Error("index read failed"));
		});
		db.close();
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

/** Drop the `"vault"` record. Without this the healed index would re-advertise paths whose databases
 *  are gone, and `listPersisted()` on iOS would hand reconcile a list of notes that do not exist. */
async function forgetLegacyIndexRecord(idb: IDBFactory): Promise<void> {
	try {
		const db = await openIndex(idb);
		await new Promise<void>((resolve, reject) => {
			const req = db
				.transaction(INDEX_STORE, "readwrite")
				.objectStore(INDEX_STORE)
				.delete(LEGACY_TENANT);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error ?? new Error("index delete failed"));
		});
		db.close();
	} catch {
		/* fail open: a broken index must never block the plugin from loading */
	}
}

function openIndex(idb: IDBFactory): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = idb.open(INDEX_DB, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(INDEX_STORE)) {
				req.result.createObjectStore(INDEX_STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("index open failed"));
	});
}

function deleteDatabase(idb: IDBFactory, name: string): Promise<void> {
	return new Promise((resolve) => {
		const req = idb.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () => resolve();
		req.onblocked = () => resolve(); // completes once the holding connection closes
	});
}
