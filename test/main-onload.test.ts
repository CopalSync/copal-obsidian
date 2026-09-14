import "fake-indexeddb/auto";
import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import CopalPlugin from "../src/main";
import type { PersistedData } from "../src/data/plugin-data-store";

/**
 * ⛔ **THE WIRING ITSELF, WHICH NOTHING USED TO REACH.**
 *
 * `wire-persistence.test.ts` proves that the five persisters share one record when they are wired that
 * way. It cannot prove that `main.ts` wires them that way — `onload()` was unreachable, because the
 * stub's `Plugin` was an empty class. So "every write goes through one store" rested on a source-level
 * count and on reading the file, which is exactly the standard of evidence that let F2 and C14 through.
 *
 * These tests run the real `onload()` against a `Plugin` whose `loadData`/`saveData` are a real
 * in-memory `data.json`, and assert against the bytes it produces.
 *
 * ⚠️ Still not covered: layout-ready (the callback is recorded, not fired, because it starts a
 * reconcile that walks a real vault), and anything that renders. G11 owns that.
 */
async function loaded(initial: PersistedData | null = null) {
	const app = new App();
	const plugin = new CopalPlugin(app as never, {} as never);
	const io = plugin as unknown as {
		loadData(): Promise<unknown>;
		saveData(d: unknown): Promise<void>;
	};
	if (initial !== null) await io.saveData(initial);
	const realSave = io.saveData.bind(io);
	const load = vi.spyOn(io, "loadData");
	const save = vi.spyOn(io, "saveData");

	await plugin.onload();
	return {
		plugin,
		app,
		load,
		save,
		/**
		 * Suspend every write until the returned release is called, while still really writing.
		 *
		 * ⚠️ Not `save.getMockImplementation()`: a `spyOn` with no mock calls through, so that returns
		 * `undefined` and a wrapper built on it silently saves nothing — the assertion then fails for a
		 * reason that has nothing to do with the hook under test.
		 */
		holdSaves: (): (() => void) => {
			let release!: () => void;
			const held = new Promise<void>((r) => {
				release = r;
			});
			save.mockImplementation(async (d: unknown) => {
				await held;
				await realSave(d);
			});
			return () => {
				save.mockImplementation(realSave);
				release();
			};
		},
		peek: async (): Promise<PersistedData> => (await io.loadData()) as PersistedData,
	};
}

describe("CopalPlugin.onload — the persistence wiring", () => {
	it("reads data.json exactly once for the whole plugin", async () => {
		const { load } = await loaded({
			tokens: { access_token: "at" },
			sync: { lastSeq: 3, knownServer: ["a.md"] },
			binary: { known: { "p.png": { etag: "e", hash: "h" } } },
		});

		// One load for five persisters. `peek()` in the fixture adds its own, hence the spy count check
		// being taken before any assertion reads the file back.
		expect(
			load,
			"main.ts must route every read through the single PluginDataStore",
		).toHaveBeenCalledOnce();
	});

	it("hands the store its own loadData/saveData, so a write from the plugin lands in data.json", async () => {
		const { plugin, peek } = await loaded();

		await plugin.store.setVault("vlt-1", "Mine");

		expect((await peek()).vaultId, "the store is writing to some other file, or to nothing").toBe(
			"vlt-1",
		);
		expect((await peek()).vaultName).toBe("Mine");
	});

	it("loads every persister's key off the one record it read", async () => {
		const { plugin } = await loaded({
			tokens: { access_token: "at" },
			vaultId: "vlt-1",
			sync: { lastSeq: 3, knownServer: ["a.md"] },
			pending: { deletes: ["gone.md"] },
			binary: { known: { "p.png": { etag: "e", hash: "h" } } },
			binaryPending: { deletes: ["old.png"] },
		});

		const internals = plugin as unknown as {
			syncState: { lastSeq: number; knownServer: string[] };
			mutationQueue: { list(): string[] };
			binaryCursor: { paths(): string[] };
			binaryQueue: { list(): string[] };
		};
		expect(plugin.store.getVaultId()).toBe("vlt-1");
		expect(internals.syncState.lastSeq).toBe(3);
		expect(internals.mutationQueue.list()).toEqual(["gone.md"]);
		expect(internals.binaryCursor.paths()).toEqual(["p.png"]);
		expect(internals.binaryQueue.list()).toEqual(["old.png"]);
	});

	it("a sign-out through the real plugin is not undone by a concurrent sync persist", async () => {
		const { plugin, peek } = await loaded({
			tokens: { access_token: "at", refresh_token: "rt" },
			vaultId: "vlt-1",
		});
		const internals = plugin as unknown as {
			syncState: { lastSeq: number; persist(): Promise<void> };
			binaryCursor: {
				set(p: string, e: { etag: string; hash: string }): void;
				persist(): Promise<void>;
			};
		};

		// S3, end to end through the assembled plugin rather than a hand-built store.
		internals.syncState.lastSeq = 11;
		internals.binaryCursor.set("p.png", { etag: "e", hash: "h" });
		await Promise.all([
			internals.binaryCursor.persist(),
			plugin.store.signOut(),
			internals.syncState.persist(),
		]);

		const disk = await peek();
		expect(disk.tokens, "a concurrent persist resurrected the credential").toBeUndefined();
		expect(disk.sync?.lastSeq).toBe(11);
		expect(disk.binary?.known["p.png"]?.etag).toBe("e");
		expect(disk.vaultId).toBe("vlt-1");
	});

	it("the quit task waits for a write that is still in flight", async () => {
		const { plugin, app, holdSaves, peek } = await loaded();
		const workspace = app.workspace as unknown as {
			handlers: { name: string }[];
			emit(name: string, ...a: unknown[]): void;
		};
		expect(
			workspace.handlers.some((h) => h.name === "quit"),
			"onunload is synchronous, so the quit task is the only hook that can await anything",
		).toBe(true);

		// Suspend the write, then quit while it is mid-flight — the case the hook exists for.
		const release = holdSaves();
		void plugin.store.setVault("vlt-1", "Mine");

		const promises: Promise<unknown>[] = [];
		workspace.emit("quit", { addPromise: (pr: Promise<unknown>) => promises.push(pr) });
		expect(promises.length).toBe(1);

		let settled = false;
		void promises[0]?.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled, "quitting must not resolve while data.json is still being written").toBe(false);

		release();
		await promises[0];
		expect((await peek()).vaultId).toBe("vlt-1");
	});

	it("an external change to data.json is adopted, not clobbered by the next write", async () => {
		const { plugin, peek } = await loaded({ clientId: "cid" });
		const io = plugin as unknown as { saveData(d: unknown): Promise<void> };

		// Another copy of the vault syncs in, linking it to a vault.
		await io.saveData({ clientId: "cid", vaultId: "from-elsewhere", vaultName: "Theirs" });
		await plugin.onExternalSettingsChange();
		await plugin.store.setTokens({ access_token: "fresh" });

		const disk = await peek();
		expect(disk.vaultId, "caching without a reload destroys another copy's fields").toBe(
			"from-elsewhere",
		);
		expect(disk.tokens?.access_token).toBe("fresh");
	});
});
