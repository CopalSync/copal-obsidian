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
	/** The dynamically-registered OAuth client id — kept across disconnects so re-connect reuses it.
	 *  ⚠️ DISCARDED when a connect attempt is started while `connectAttemptPending` is still set: see
	 *  the note on `ConnectFlow.start`. A registration the server has forgotten is otherwise a dead
	 *  end with no way out from inside the plugin. */
	clientId?: string;
	/**
	 * The scope `clientId` was REGISTERED with — the registration's identity, not a preference.
	 *
	 * ⛔ `/oauth2/authorize` validates the requested scope against `client.scopes` as captured at
	 * registration, so a client registered with one scope can never be authorized with another: it
	 * is refused with `invalid_scope` before any redirect we can observe. Reusing a registration is
	 * therefore only safe when it was made with the scope we are about to ask for, and this field is
	 * how `ConnectFlow.start` knows. `undefined` means "registered before this was recorded", which
	 * is not the same as "matches" — see the migration note there.
	 */
	clientScope?: string;
	/** Set when a connect attempt opens the browser, cleared when the callback lands. Still set at
	 *  the start of the next attempt means the last one died somewhere the plugin cannot see —
	 *  `/oauth2/authorize` refusing an unknown client never reaches our redirect. */
	connectAttemptPending?: boolean;
	tokens?: Tokens;
	/** A stable id for this install, stamped into conflict-copy names and the presence colour. */
	deviceId?: string;
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
 * These are the account-scoped facts that legitimately travel with a synced vault. Everything absent
 * from this list is deliberately absent:
 *  - `deviceId` is cached into a field at load and an adoption would desynchronise it;
 *  - `connectAttemptPending` belongs to a browser hop happening on THIS device;
 *  - `sync`, `pending`, `binary` and `binaryPending` describe this device's relationship to the server.
 *    Adopting another device's `lastSeq` would skip journal frames this client never applied, and its
 *    `binary.known` would skip pulls for files this device does not have.
 *  - `tokens` is handled separately and asymmetrically — see `reloadExternal`.
 */
const ADOPTABLE = ["clientId", "clientScope", "vaultId", "vaultName", "legacyCrdtPurged"] as const;

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

function asRecord(loaded: unknown): PersistedData {
	return typeof loaded === "object" && loaded !== null ? (loaded as PersistedData) : {};
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
	static async open(io: PluginDataIo): Promise<PluginDataStore> {
		return new PluginDataStore(io, asRecord(await io.load()));
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
	 * has not written". That rule sounds safer and is not: a device that refreshed its token this
	 * session would treat `tokens` as its own and write a live credential back over another device's
	 * sign-out, reversing it on disk and syncing the reversal back.
	 *
	 * `tokens` therefore gets one asymmetric rule: **adopt a sign-out, never a sign-in.** Tokens that
	 * have GONE from disk mean another copy signed out, and following that fails closed. Tokens
	 * appearing when we have none is a sign-in elsewhere that a reload picks up anyway, and adopting it
	 * mid-session buys nothing. Telling those apart needs the previous disk record, because with
	 * `exactOptionalPropertyTypes` an absence is not a value — hence {@link disk}.
	 */
	async reloadExternal(): Promise<void> {
		const next = asRecord(await this.io.load());
		const previous = this.disk;
		this.disk = copy(next);

		for (const key of ADOPTABLE) {
			const incoming = next[key];
			if (incoming === undefined) continue;
			if (JSON.stringify(incoming) === JSON.stringify(previous[key])) continue;
			this.record = { ...this.record, [key]: incoming };
		}

		if (next.tokens === undefined && previous.tokens !== undefined) {
			const { tokens: _signedOutElsewhere, ...rest } = this.record;
			this.record = rest;
		}
	}
}
