import { TokenStore } from "../connect/store";
import { BinaryCursor } from "../sync/binary-cursor";
import { MutationQueue } from "../sync/mutation-queue";
import { SyncState } from "../sync/state";
import { type PluginDataIo, PluginDataStore } from "./plugin-data-store";

/** Everything that persists into `data.json`, already loaded and ready to use. */
export interface Persistence {
	data: PluginDataStore;
	store: TokenStore;
	syncState: SyncState;
	mutationQueue: MutationQueue;
	binaryCursor: BinaryCursor;
	binaryQueue: MutationQueue;
}

/**
 * Build the five persisters over one `data.json`.
 *
 * ⛔ **This lives outside `main.ts` so that a test can run it.** The five wirings used to be inline in
 * `onload()`, which no test reaches: the Obsidian stub's `Plugin` is an empty class and `onload` also
 * wants `registerEvent`, `addCommand`, `registerView`, `addSettingTab`, `onLayoutReady` and
 * `vault.on` — a real test double is roadmap row G11, not this change. So the code that decides how
 * the record is shared moved out to where `wire-persistence.test.ts` can drive it. That is the same
 * reason `connect/sign-out.ts` exists, and the same class of gap that let two security findings
 * survive a green suite: the logic that mattered lived in the one file nothing could load.
 *
 * ⚠️ `loadData`/`saveData` are passed in and must be called NOWHERE else in `src/` —
 * `test/store-rules.test.ts` counts the occurrences and fails if a second one appears.
 */
export function wirePersistence(io: PluginDataIo): Promise<Persistence> {
	return PluginDataStore.open(io).then((data) => {
		const syncState = new SyncState(data.slice("sync"));
		const mutationQueue = new MutationQueue(data.slice("pending"));
		const binaryCursor = new BinaryCursor(data.slice("binary"));
		const binaryQueue = new MutationQueue(data.slice("binaryPending"));
		syncState.init();
		mutationQueue.init();
		binaryCursor.init();
		binaryQueue.init();
		return {
			data,
			store: new TokenStore(data),
			syncState,
			mutationQueue,
			binaryCursor,
			binaryQueue,
		};
	});
}
