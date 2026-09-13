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
 * ⚠️ **What is lost is history, not text, but the loss is VISIBLE.** The `.md` file on disk is the
 * projection of its doc, so every note's current content survives untouched. What lineage buys is the
 * ability to tell a STALE local file from an unknown one: `reconcileFileAfterSync` treats an empty doc
 * as a first import, so the first time you open a note this device was BEHIND on, its old local text is
 * kept beside it as a `(conflicted copy)` instead of being merged away silently. Nothing is lost — that
 * is what keep-both is for — but a vault can sprout one copy per drifted note. Measured, not assumed:
 * see "a note this device was behind on, across an upgrade" in `test/crdt/crdt-sync.test.ts`, which
 * runs both halves against the same server and the same files.
 *
 * Pushing local text up before the purge would avoid the copies and is WRONG: this device is the one
 * that is behind, so it would overwrite a newer edit made somewhere else. `knownServer` is kept, so the next merge reconcile
 * pulls the server's notes into fresh documents and pushes anything genuinely local-only. What goes is
 * CRDT lineage: struct client ids and clocks, which is what makes a merge of two old offline edits
 * smarter than a last-writer-wins. That is a real cost, accepted deliberately over the alternative.
 *
 * Returns the names deleted, and whether it finished — `completed: false` means the caller must NOT
 * record the purge as done, or a run that timed out would never be retried.
 *
 * ⚠️ **Bounded, because the caller awaits this during `onload`.** An IndexedDB open can block
 * indefinitely (another connection holding a version change), and a plugin that never finishes loading
 * is a far worse failure than a purge that waits for the next launch.
 */
export async function purgeLegacyCrdtDocs(
	budgetMs = 10_000,
): Promise<{ names: string[]; completed: boolean }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<{ names: string[]; completed: boolean }>((resolve) => {
		timer = setTimeout(() => resolve({ names: [], completed: false }), budgetMs);
	});
	try {
		return await Promise.race([purge(), budget]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function purge(): Promise<{ names: string[]; completed: boolean }> {
	const idb = globalThis.indexedDB;
	if (!idb) return { names: [], completed: true };

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
	return { names, completed: true };
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
		// Another connection is holding a version change. Give up rather than wait forever: every caller
		// of this treats a failure as an empty inventory, and the purge is retried on the next launch.
		req.onblocked = () => reject(new Error("index open blocked"));
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
