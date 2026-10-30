import type { App } from "obsidian";
import { CredentialStore, type LocalPort } from "../../src/connect/credential-store";
import { TokenStore } from "../../src/connect/store";
import { type PersistedData, PluginDataStore } from "../../src/data/plugin-data-store";
import type { Tokens } from "../../src/types";
import { SecretStorage } from "../stubs/obsidian";

/**
 * An in-memory `data.json` behind a real {@link PluginDataStore}.
 *
 * This replaces seven near-identical `memStore`/`mem`/`makeQueue`/`inMemoryCursor` fixtures that each
 * rolled their own `(load, save)` pair. They existed because every persister took that pair; now they
 * share one record, so the double is shared too.
 *
 * ⚠️ `peek()` is the DISK, not the canonical in-memory record, and the two are not the same thing while
 * a write is in flight. Several assertions here are negative — "the sign-out is still gone", "the
 * rotated token was never written" — and pointing `peek` at the in-memory record would leave them
 * passing against an implementation that only guards the write. Await the operation (or `flush()`)
 * before peeking.
 */
export function memData(initial: PersistedData = {}) {
	const clone = (d: PersistedData): PersistedData => JSON.parse(JSON.stringify(d)) as PersistedData;
	let disk = clone(initial);
	const io = {
		load: async (): Promise<unknown> => clone(disk),
		save: async (d: PersistedData): Promise<void> => {
			disk = clone(d);
		},
	};
	return {
		io,
		open: (): Promise<PluginDataStore> => PluginDataStore.open(io),
		/** What a reader of the file would see. */
		peek: (): PersistedData => disk,
		/** Replace the file underneath the plugin, as a sync service would. */
		externalWrite: (next: PersistedData): void => {
			disk = clone(next);
		},
	};
}

/**
 * This device's secret store and vault localStorage, in memory, as Obsidian keeps them (the stub's
 * `SecretStorage`). Pass one `secrets` to two calls to model mobile, where every vault on the phone
 * shares the store.
 */
export function memCredentials(secrets: SecretStorage = new SecretStorage()) {
	const local = new Map<string, unknown>();
	const vault: LocalPort = {
		loadLocalStorage: (key) => local.get(key) ?? null,
		saveLocalStorage: (key, value) => {
			if (value === null || value === undefined) local.delete(key);
			else local.set(key, value);
		},
	};
	return { secrets, local, credentials: new CredentialStore(secrets, vault) };
}

/**
 * Sign `app` in the way a device on this build is signed in: the credential in its secret store, under
 * the id it keeps in the vault's localStorage. `onload()` then finds it there, as Obsidian would.
 */
export function signInOn(app: App, tokens: Tokens, clientId = "cid"): void {
	new CredentialStore(app.secretStorage, app).setSignedIn({ tokens, clientId });
}

/** A starting state: what `data.json` holds, and the sign-in this device's secret store holds. */
export type Seed = PersistedData & { tokens?: Tokens; clientId?: string };

/**
 * The common case: a `TokenStore` over an in-memory `data.json` and secret store.
 *
 * `tokens` and `clientId` in the seed go to the SECRET STORE, where a signed-in device keeps them; seed
 * `data.json` itself through {@link memData} to test a sign-in an older build left there. `peek()` is
 * the file; `signIn()` is the credential as the secret store holds it.
 */
export async function memStore(seed: Seed = {}): Promise<{
	store: TokenStore;
	data: PluginDataStore;
	credentials: CredentialStore;
	secrets: SecretStorage;
	peek: () => PersistedData;
	signIn: () => ReturnType<CredentialStore["signedIn"]>;
	externalWrite: (next: PersistedData) => void;
}> {
	const { tokens, clientId, ...file } = seed;
	if (tokens !== undefined && clientId === undefined) {
		throw new Error("a sign-in always has the client its tokens were issued to: seed a clientId");
	}
	const mem = memData(file);
	const data = await mem.open();
	const { secrets, credentials } = memCredentials();
	if (tokens !== undefined && clientId !== undefined) credentials.setSignedIn({ tokens, clientId });
	return {
		store: new TokenStore(data, credentials),
		data,
		credentials,
		secrets,
		peek: mem.peek,
		signIn: () => credentials.signedIn(),
		externalWrite: mem.externalWrite,
	};
}

/**
 * One key of an in-memory record, as a real {@link PluginDataStore} slice.
 *
 * Deliberately the real slice rather than a hand-rolled `{get,set}`: the copy-on-the-way-in/out is part
 * of the contract these persisters depend on, and a double without it would let an aliasing regression
 * through (mutating the cursor in place would stop `persist()` being the commit point).
 */
export async function memSlice<K extends keyof PersistedData>(
	key: K,
	initial?: PersistedData[K],
): Promise<{
	slice: ReturnType<PluginDataStore["slice"]> extends never ? never : ReturnType<typeof sliceOf<K>>;
	peek: () => PersistedData[K];
	data: PluginDataStore;
}> {
	const mem = memData(initial === undefined ? {} : ({ [key]: initial } as PersistedData));
	const data = await mem.open();
	return { slice: sliceOf(data, key), peek: () => mem.peek()[key], data };
}

function sliceOf<K extends keyof PersistedData>(data: PluginDataStore, key: K) {
	return data.slice(key);
}
