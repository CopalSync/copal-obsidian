import { PathQueue } from "../crdt/path-queue";
import type { BinaryData } from "../sync/binary-cursor";
import type { MutationData } from "../sync/mutation-queue";
import type { SyncData } from "../sync/state";
import type { Tokens } from "../types";

/**
 * The plugin's persisted state — the whole of Obsidian's `data.json`, in one place for the first time.
 *
 * Every key is optional and `exactOptionalPropertyTypes` is on, so "absent" and "present as
 * `undefined`" are different types. That distinction is load-bearing: `signOut` and `unlinkVault` must
 * REMOVE keys, and only a removal round-trips through JSON as an absence.
 */
export interface PersistedData {
	/** The Copal vault this Obsidian folder is linked to — sent as `X-Copal-Vault`. Set while connected;
	 *  a linked folder resumes on reload/re-auth. **Disconnect clears it** (fully unlink) → the next login
	 *  shows the adopt screen. */
	vaultId?: string;
	vaultName?: string;
	/**
	 * Set once the constant-tenant CRDT databases have been discarded. See `purgeLegacyCrdtDocs`.
	 *
	 * `undefined` means "not yet purged", which is correct for both a pre-upgrade install and a brand
	 * new one: a new install has no legacy databases, so the purge is a cheap no-op that marks itself
	 * done. Deliberately one-way — there is no state in which they should come back.
	 */
	legacyCrdtPurged?: true;

	/*
	 * The four sub-records below used to be cast in at each wiring site in `main.ts` and survived only
	 * because a spread copies keys the type does not know about. They are declared here so the record
	 * has one true shape. This is a prerequisite for the slice API, not a bug fix — nothing was
	 * dropping them — and it buys no validation: `loadData()` returns `any`, so a `sync` record missing
	 * `knownServer` still types as `SyncData` and still lies. The persisters' own `init()` defaulting
	 * is what actually handles that.
	 */
	sync?: SyncData;
	pending?: MutationData;
	binary?: BinaryData;
	binaryPending?: MutationData;
}

/**
 * ⛔ **A sign-in found in `data.json`** (audit NV33). Builds before 1.1.0 kept `tokens` and the `clientId`
 * they were issued to here, inside the vault folder, so every copy of the folder carried them. This
 * build never writes them, and treats any it finds as exposed: they are taken out of the record and
 * handed to `onLegacyCredential`, which revokes them. That covers this device's own pre-1.1.0 sign-in on
 * its first load, and one a device still on an older build writes into a synced `data.json` later.
 */
export interface LegacyCredential {
	tokens: Tokens;
	clientId?: string;
}

/** The keys an older build kept the sign-in under. Never written by this one. */
interface LegacyKeys {
	tokens?: Tokens;
	clientId?: string;
}

/** One key of the record, handed to the persister that owns it. */
export interface DataSlice<T> {
	get(): T | undefined;
	set(value: T): Promise<void>;
}

/** Obsidian's `loadData`/`saveData`, or an in-memory pair in tests. */
export interface PluginDataIo {
	load(): Promise<unknown>;
	save(data: PersistedData): Promise<void>;
}

/**
 * The keys an externally-changed `data.json` is allowed to bring in. See `reloadExternal`.
 *
 * These are the facts about the FOLDER that legitimately travel with a synced vault. Everything absent
 * from this list is deliberately absent:
 *  - `sync`, `pending`, `binary` and `binaryPending` describe this device's relationship to the server.
 *    Adopting another device's `lastSeq` would skip journal frames this client never applied, and its
 *    `binary.known` would skip pulls for files this device does not have.
 *  - the sign-in is not in this file at all; one found here is revoked, never adopted (see
 *    {@link LegacyCredential}).
 */
const ADOPTABLE = ["vaultId", "vaultName", "legacyCrdtPurged"] as const;

/** The single key the write queue is serialised on. There is one file, so there is one key. */
const THE_FILE = "data.json";

/**
 * Deep-copy at the slice boundary.
 *
 * ⛔ **This is not defensive tidiness; without it `persist()` stops being the commit point.** The three
 * sub-key persisters copy the top level of their slice at `init()` and alias the inside of it
 * (`binary-cursor.ts` `known`, `mutation-queue.ts` `deletes`). Against a throwaway JSON parse — which
 * is what `load()` used to hand out on every single read — that was harmless. Against ONE canonical
 * record it means `cursor.set(path, entry)` mutates the canonical record in place, so an unrelated
 * writer's coalesced write, or the flush at quit, persists a cursor claiming files are synced before
 * they were actually written. Last-writer-wins then never pulls them again.
 *
 * Copying at the boundary fixes it once, rather than relying on every present and future persister to
 * remember not to mutate. `JSON` rather than `structuredClone`: this is exactly the serialisation the
 * value is about to undergo anyway, it cannot be defeated by a non-serialisable value sneaking through,
 * and it has no minimum-webview-version question on mobile.
 */
function copy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(loaded: unknown): PersistedData & LegacyKeys {
	return typeof loaded === "object" && loaded !== null
		? (loaded as PersistedData & LegacyKeys)
		: {};
}

/** The sign-in an older build left in `record`, if any, and the record without it. */
function splitLegacy(record: PersistedData & LegacyKeys): {
	legacy: LegacyCredential | undefined;
	held: boolean;
	rest: PersistedData;
} {
	const { tokens, clientId, ...rest } = record;
	const legacy =
		tokens === undefined ? undefined : clientId === undefined ? { tokens } : { tokens, clientId };
	return { legacy, held: tokens !== undefined || clientId !== undefined, rest };
}

/**
 * The one writer for `data.json`.
 *
 * ⛔ **The point is that there is no read-modify-write window at all.** Five persisters used to each do
 * `save({ ...(await load()), theirKey })`, so a `delete data.tokens` in `TokenStore.signOut` could be
 * undone by any of them spreading a read taken before it: sign-out reported success and the credential
 * stayed on disk, in a file that syncs to iCloud, Obsidian Sync and git. A mutation here lands on one
 * canonical in-memory record synchronously, and the write emits whatever that record currently says, so
 * there is nothing stale to spread. (This is S3. It is NOT C14 — a refresh suspended across the network
 * resurrecting a credential is still held off solely by `TokenManager`'s `abandoned` latch.)
 *
 * Writes are eager and coalesced: one goes out immediately, and anything arriving while it is in flight
 * collapses into a single trailing write. No timer and no deferral, deliberately — `live.test.ts` counts
 * microtasks between `start()` and the cursor reaching disk, and the ordering it pins (persist the
 * cursor BEFORE opening the socket, or `since=` resumes from a stale value) is a real property.
 */
export class PluginDataStore {
	private readonly writes = new PathQueue();
	/** The last record seen on disk, kept so `reloadExternal` can tell "removed" from "never there". */
	private disk: PersistedData;

	private constructor(
		private readonly io: PluginDataIo,
		private record: PersistedData,
		private readonly onLegacyCredential: (credential: LegacyCredential) => void,
	) {
		this.disk = copy(record);
	}

	/**
	 * Read `data.json` once. Every accessor afterwards is served from memory — that is P3.
	 *
	 * ⚠️ "One load" means one load on the startup path, not one load ever: `reloadExternal` reads again,
	 * because Obsidian's `onExternalSettingsChange` hands over no payload. The `io.load` thunk is
	 * retained for that and is not a leftover.
	 */
	static async open(
		io: PluginDataIo,
		onLegacyCredential: (credential: LegacyCredential) => void = () => {},
	): Promise<PluginDataStore> {
		const { legacy, held, rest } = splitLegacy(asRecord(await io.load()));
		const store = new PluginDataStore(io, rest, onLegacyCredential);
		if (legacy !== undefined) onLegacyCredential(legacy);
		// Off the disk at once, so the credential stops travelling with the folder from this load on.
		if (held) await store.update(() => {});
		return store;
	}

	/** The canonical record. Synchronous: there is no I/O behind it. */
	read(): Readonly<PersistedData> {
		return this.record;
	}

	/**
	 * Mutate the record and persist it. The mutation is applied synchronously, before this returns.
	 *
	 * ⚠️ The returned promise is the TRAILING write's, never the one already in flight. Handing back a
	 * running write would resolve `await state.persist()` on a write that does not contain the caller's
	 * change — and `SyncClient.start` would then open the socket with the cursor not yet on disk.
	 * `PathQueue.run` is defined as "a run that STARTS AFTER this call", which is exactly that
	 * guarantee; `PathQueue.coalesce` is the opposite and must not be used here.
	 */
	update(mutate: (draft: PersistedData) => void): Promise<void> {
		mutate(this.record);
		return this.writes.run(THE_FILE, () => this.io.save(this.record));
	}

	/** A handle on one key, for the persister that owns it. Copies both ways — see {@link copy}. */
	slice<K extends keyof PersistedData>(key: K): DataSlice<NonNullable<PersistedData[K]>> {
		type T = NonNullable<PersistedData[K]>;
		return {
			get: (): T | undefined => {
				const value = this.record[key];
				return value === undefined ? undefined : copy(value as T);
			},
			set: (value: T): Promise<void> =>
				this.update((draft) => {
					draft[key] = copy(value);
				}),
		};
	}

	/** Resolve once nothing is queued or in flight. Registered on Obsidian's `quit` task. */
	async flush(): Promise<void> {
		await this.writes.drain(THE_FILE);
	}

	/**
	 * `data.json` changed on disk underneath us — a Sync service, another vault copy, an external edit.
	 *
	 * ⛔ **Caching is what creates the need for this.** The old code spread a fresh read into every
	 * write, so a key another device owned survived ours by accident. One cached record would silently
	 * destroy it on the next write. This is the price of the cache, not an extra.
	 *
	 * The policy is an explicit allowlist ({@link ADOPTABLE}) rather than "adopt anything this session
	 * has not written". A sign-in is never adopted: one found on disk was written by a device on an older
	 * build, is exposed by being there, and is revoked and taken off the disk like the one {@link open}
	 * finds. That write reaches the other device as a sign-out, which is what an exposed credential
	 * should cost it.
	 */
	async reloadExternal(): Promise<void> {
		const { legacy, held, rest: next } = splitLegacy(asRecord(await this.io.load()));
		const previous = this.disk;
		this.disk = copy(next);

		for (const key of ADOPTABLE) {
			const incoming = next[key];
			if (incoming === undefined) continue;
			if (JSON.stringify(incoming) === JSON.stringify(previous[key])) continue;
			this.record = { ...this.record, [key]: incoming };
		}

		if (legacy !== undefined) this.onLegacyCredential(legacy);
		if (held) await this.update(() => {});
	}
}
