import { type PersistedData, PluginDataStore } from "../../src/data/plugin-data-store";
import { TokenStore } from "../../src/connect/store";

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

/** The common case: a `TokenStore` over an in-memory record, with the raw record still observable. */
export async function memStore(initial: PersistedData = {}): Promise<{
	store: TokenStore;
	data: PluginDataStore;
	peek: () => PersistedData;
	externalWrite: (next: PersistedData) => void;
}> {
	const mem = memData(initial);
	const data = await mem.open();
	return { store: new TokenStore(data), data, peek: mem.peek, externalWrite: mem.externalWrite };
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
