// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { App } from "obsidian";
import { secretsOf, workspaceOf } from "./stubs/obsidian";
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
 * Layout-ready is covered in `test/main-layout-ready.test.ts` — the double can fire it now, so the
 * startup path inside it is no longer dead code under test. (G11.)
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
			vaultId: "vlt-1",
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

	it("an unlink through the real plugin is not undone by a concurrent sync persist", async () => {
		const { plugin, peek } = await loaded({ vaultId: "vlt-1", vaultName: "Mine" });
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
			plugin.store.unlinkVault(),
			internals.syncState.persist(),
		]);

		const disk = await peek();
		expect("vaultId" in disk, "a concurrent persist resurrected the link").toBe(false);
		expect(disk.sync?.lastSeq).toBe(11);
		expect(disk.binary?.known["p.png"]?.etag).toBe("e");
	});

	/** ⛔ NV33, through the assembled plugin: the sign-in goes to `app.secretStorage`, never the file. */
	it("a sign-in lands in Obsidian's secret store and not in data.json", async () => {
		const { plugin, app, peek } = await loaded({ vaultId: "vlt-1" });
		await plugin.store.completeSignIn(
			{ access_token: "DUMMY-AT", refresh_token: "DUMMY-RT" },
			"cid",
		);

		expect(JSON.stringify(await peek())).not.toContain("DUMMY");
		const secrets = secretsOf(app);
		expect(secrets.listSecrets()).toHaveLength(1);
		expect(secrets.getSecret(secrets.listSecrets()[0] ?? "")).toContain("DUMMY-RT");
	});

	it("an old build's sign-in in data.json is taken off the disk, kept only to revoke, and not used", async () => {
		const { plugin, app, peek } = await loaded({
			tokens: { access_token: "DUMMY-AT", refresh_token: "DUMMY-RT" },
			clientId: "cid",
			vaultId: "vlt-1",
		} as PersistedData);

		expect(JSON.stringify(await peek())).not.toContain("DUMMY");
		expect(plugin.store.isConnected()).toBe(false);
		const secrets = secretsOf(app);
		const held = JSON.parse(secrets.getSecret(secrets.listSecrets()[0] ?? "") ?? "{}") as unknown;
		expect(held).toEqual({ revoke: [{ refresh_token: "DUMMY-RT", clientId: "cid" }] });
	});

	it("the quit task waits for a write that is still in flight", async () => {
		const { plugin, app, holdSaves, peek } = await loaded();

		// Suspend the write, then quit while it is mid-flight — the case the hook exists for.
		const release = holdSaves();
		void plugin.store.setVault("vlt-1", "Mine");

		// `trigger` is Obsidian's own name for firing an event, so this drives the documented API
		// rather than reaching into the double's internals as it used to.
		const promises: Promise<unknown>[] = [];
		workspaceOf(app).trigger("quit", { addPromise: (pr: Promise<unknown>) => promises.push(pr) });
		expect(
			promises.length,
			"onunload is synchronous, so the quit task is the only hook that can await anything",
		).toBe(1);

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
		const { plugin, peek } = await loaded({ legacyCrdtPurged: true });
		const io = plugin as unknown as { saveData(d: unknown): Promise<void> };

		// Another copy of the vault syncs in, linking it to a vault.
		await io.saveData({ legacyCrdtPurged: true, vaultId: "from-elsewhere", vaultName: "Theirs" });
		await plugin.onExternalSettingsChange();
		// Then this device writes its own key.
		const internals = plugin as unknown as {
			syncState: { lastSeq: number; persist(): Promise<void> };
		};
		internals.syncState.lastSeq = 5;
		await internals.syncState.persist();

		const disk = await peek();
		expect(disk.vaultId, "caching without a reload destroys another copy's fields").toBe(
			"from-elsewhere",
		);
		expect(disk.sync?.lastSeq).toBe(5);
	});
});

/**
 * G5. `onunload` used to call `stopSync()` alone: it closed the active note's socket and stopped the
 * change bus, and left every persisted doc resident with its IndexedDB connection open and any
 * coalesced write unflushed. On a plugin reload — an update, or toggling it off and on — that left a
 * second set of documents and connections alongside the first.
 */
describe("onunload releases what the plugin owns", () => {
	it("closes the document store, not only the sockets", async () => {
		const { plugin } = await loaded();
		const internals = plugin as unknown as {
			registry: { closeAll: () => Promise<void> } | undefined;
		};
		const registry = internals.registry;
		expect(registry, "onload did not build a registry, so this proves nothing").toBeDefined();
		const closeAll = vi.spyOn(registry as { closeAll: () => Promise<void> }, "closeAll");

		plugin.onunload();

		await vi.waitFor(() => {
			expect(closeAll, "the document store was left open on unload").toHaveBeenCalled();
		});
	});

	it("stops accepting sync work before closing the documents underneath it", async () => {
		const { plugin } = await loaded();
		const internals = plugin as unknown as {
			syncActive: boolean;
			registry: { closeAll: () => Promise<void> };
		};
		internals.syncActive = true;
		const order: string[] = [];
		vi.spyOn(internals.registry, "closeAll").mockImplementation(async () => {
			order.push("closeAll");
		});

		plugin.onunload();
		order.unshift(internals.syncActive ? "stillAccepting" : "gateClosed");

		await vi.waitFor(() => expect(order).toContain("closeAll"));
		// The gate must already be shut by the time the documents go — a page started after this point
		// would be torn out from under itself.
		expect(order[0]).toBe("gateClosed");
	});
});
