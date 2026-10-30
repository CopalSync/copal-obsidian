import { describe, expect, it, vi } from "vitest";
import {
	type LegacyCredential,
	type PersistedData,
	PluginDataStore,
} from "../../src/data/plugin-data-store";

/**
 * An in-memory `data.json`.
 *
 * ⚠️ `save` snapshots via JSON rather than keeping the reference it was handed. Obsidian's `saveData`
 * serialises, so the bytes on disk are frozen at write time — and a double that stored the live object
 * would let a LATER mutation rewrite what an EARLIER write is recorded as having persisted. Every
 * negative assertion in this file ("the sign-out is still on disk") would then pass for the wrong reason.
 */
/** What an older build wrote: the record plus the sign-in it kept there. */
type OnDisk = PersistedData & {
	tokens?: { access_token: string; refresh_token?: string };
	clientId?: string;
};

function fakeDisk(initial: OnDisk = {}) {
	let disk: OnDisk = JSON.parse(JSON.stringify(initial)) as OnDisk;
	const writes: PersistedData[] = [];
	let gate: Promise<void> | undefined;
	const load = vi.fn(async (): Promise<unknown> => JSON.parse(JSON.stringify(disk)));
	const save = vi.fn(async (data: PersistedData): Promise<void> => {
		const snapshot = JSON.parse(JSON.stringify(data)) as PersistedData;
		if (gate) await gate;
		disk = snapshot;
		writes.push(snapshot);
	});
	return {
		io: { load, save },
		load,
		save,
		writes,
		/** What a reader of the file would see. */
		peek: (): OnDisk => disk,
		/** Replace the file underneath the plugin, as a sync service would. */
		externalWrite: (next: OnDisk) => {
			disk = JSON.parse(JSON.stringify(next)) as OnDisk;
		},
		/** Hold every `save` until the returned release is called. */
		hold: () => {
			let release!: () => void;
			gate = new Promise<void>((r) => {
				release = r;
			});
			return () => {
				gate = undefined;
				release();
			};
		},
	};
}

/**
 * Drain microtasks until `cond` holds.
 *
 * ⚠️ One `await Promise.resolve()` is not enough to get a write to its suspension point — `update`
 * returns before `PathQueue` has started the job. Driving a race against that tests the wrong
 * interleaving and passes for the wrong reason. (Same hazard, same fix, as `token-manager.test.ts`.)
 */
async function until(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100 && !cond(); i += 1) await Promise.resolve();
	if (!cond()) throw new Error(`never happened: ${what}`);
}

describe("PluginDataStore: one load", () => {
	it("reads the file once, however many accessors run", async () => {
		const d = fakeDisk({ vaultId: "vlt-1", vaultName: "Work" });
		const store = await PluginDataStore.open(d.io);

		for (let i = 0; i < 20; i += 1) {
			expect(store.read().vaultId).toBe("vlt-1");
			expect(store.read().vaultName).toBe("Work");
		}

		expect(
			d.load,
			"P3: every accessor after startup must be served from memory",
		).toHaveBeenCalledOnce();
	});

	it("treats a null or absent file as an empty record", async () => {
		const load = vi.fn(async (): Promise<unknown> => null);
		const store = await PluginDataStore.open({ load, save: vi.fn(async () => {}) });
		expect(store.read()).toEqual({});
	});
});

describe("PluginDataStore: the write queue", () => {
	it("collapses a burst of concurrent updates into one in-flight and one trailing write", async () => {
		const d = fakeDisk();
		const store = await PluginDataStore.open(d.io);

		// Un-awaited on purpose. Awaited calls each complete before the next begins, so they cannot
		// coalesce and a burst test built from them would prove nothing.
		const all = Promise.all([
			store.update((r) => {
				r.sync = { lastSeq: 1, knownServer: [] };
			}),
			store.update((r) => {
				r.vaultId = "b";
			}),
			store.update((r) => {
				r.vaultName = "c";
			}),
			store.update((r) => {
				r.legacyCrdtPurged = true;
			}),
		]);
		await all;

		expect(d.save.mock.calls.length, "four updates must not be four writes").toBeLessThanOrEqual(2);
		// The count alone would pass for a writer that never writes, so pin the content too.
		expect(d.peek()).toEqual({
			sync: { lastSeq: 1, knownServer: [] },
			vaultId: "b",
			vaultName: "c",
			legacyCrdtPurged: true,
		});
	});

	it("resolves an update only once ITS value is on disk, not when an earlier write lands", async () => {
		const d = fakeDisk();
		const store = await PluginDataStore.open(d.io);

		const release = d.hold();
		const first = store.update((r) => {
			r.vaultName = "first";
		});
		await until(() => d.save.mock.calls.length === 1, "the first write reached the disk");

		// Arrives while the first write is suspended: it must ride the TRAILING write, not this one.
		let secondSettled = false;
		const second = store
			.update((r) => {
				r.vaultId = "second";
			})
			.then(() => {
				secondSettled = true;
			});

		release();
		await first;
		expect(
			secondSettled,
			"resolving on the in-flight write would let SyncClient open the socket before the cursor is on disk",
		).toBe(false);

		await second;
		expect(d.peek().vaultId).toBe("second");
	});

	it("keeps accepting work that arrives while the trailing write is itself running", async () => {
		const d = fakeDisk();
		const store = await PluginDataStore.open(d.io);
		const seen: string[] = [];
		d.save.mockImplementation(async (data: PersistedData) => {
			seen.push(data.vaultName ?? "?");
		});

		const a = store.update((r) => {
			r.vaultName = "a";
		});
		const b = store.update((r) => {
			r.vaultName = "b";
		});
		await Promise.all([a, b]);
		const c = store.update((r) => {
			r.vaultName = "c";
		});
		await c;

		expect(seen.at(-1), "an update after the trailing write must still get a write").toBe("c");
	});

	it("flush() resolves only once nothing is queued or in flight", async () => {
		const d = fakeDisk();
		const store = await PluginDataStore.open(d.io);

		const release = d.hold();
		void store.update((r) => {
			r.vaultName = "a";
		});
		await until(() => d.save.mock.calls.length === 1, "the write started");
		void store.update((r) => {
			r.vaultId = "b";
		});

		let flushed = false;
		const flushing = store.flush().then(() => {
			flushed = true;
		});
		await Promise.resolve();
		expect(flushed).toBe(false);

		release();
		await flushing;
		expect(d.peek()).toEqual({ vaultName: "a", vaultId: "b" });
	});

	it("releases the queue when a write throws, so later writes still land", async () => {
		const d = fakeDisk();
		const store = await PluginDataStore.open(d.io);
		d.save.mockRejectedValueOnce(new Error("disk full"));

		await expect(
			store.update((r) => {
				r.vaultName = "a";
			}),
		).rejects.toThrow("disk full");

		await store.update((r) => {
			r.vaultId = "b";
		});
		expect(d.peek().vaultId).toBe("b");
	});
});

describe("PluginDataStore: S3, the resurrection race", () => {
	/**
	 * ⛔ THE ONE THIS EXISTS FOR. A persister's write is suspended; a removal lands while it hangs.
	 *
	 * Under the old idiom the suspended writer held `{ ...staleRead }` — a snapshot taken BEFORE the
	 * delete — and putting it down re-created the key. It was found as a sign-out resurrecting the
	 * credential (the credential is not in this file any more, NV33); it holds for every removal, and the
	 * vault link's is the one left: an unlink that came back would re-link a folder to a vault it left.
	 */
	it("a removal during a suspended write is not undone by it", async () => {
		const d = fakeDisk({ vaultId: "vlt-1", vaultName: "Work", legacyCrdtPurged: true });
		const store = await PluginDataStore.open(d.io);

		const release = d.hold();
		const cursorPersist = store.update((r) => {
			r.binary = { known: { "a.png": { etag: "e", hash: "h" } } };
		});
		await until(() => d.save.mock.calls.length === 1, "the cursor write reached the disk");

		const unlink = store.update((r) => {
			delete r.vaultId;
			delete r.vaultName;
		});
		release();
		await Promise.all([cursorPersist, unlink]);

		expect(d.peek().vaultId, "the link was resurrected by a concurrent persist").toBeUndefined();
		expect("vaultId" in d.peek(), "the key must be ABSENT, not present-and-undefined").toBe(false);
		// The other writer's work is not lost either — this is a merge, not a last-writer-wins.
		expect(d.peek().binary?.known["a.png"]?.etag).toBe("e");
		expect(d.peek().legacyCrdtPurged).toBe(true);
	});

	/**
	 * The falsifier for the test above, kept in the suite rather than done by hand and deleted.
	 *
	 * It drives the SAME interleaving against the idiom `main.ts` used to use, and asserts the bug is
	 * real. If this ever stops resurrecting the key, the interleaving has stopped being driven and the
	 * test above is no longer proving anything.
	 */
	it("the same interleaving against a read-modify-write persister DOES resurrect it", async () => {
		const d = fakeDisk({ vaultId: "vlt-1" });
		const store = await PluginDataStore.open(d.io);

		// The old idiom, verbatim: read the whole record...
		const stale = (await d.io.load()) as PersistedData;
		// ...the unlink lands...
		await store.update((r) => {
			delete r.vaultId;
		});
		expect(d.peek().vaultId).toBeUndefined();
		// ...and only now does the persister put its spread of the stale read down.
		await d.io.save({ ...stale, binary: { known: {} } });

		expect(
			d.peek().vaultId,
			"if this stops resurrecting, the interleaving above is no longer the dangerous one and the test before it proves nothing",
		).toBe("vlt-1");
	});

	it("removes keys rather than writing them as undefined", async () => {
		const d = fakeDisk({ legacyCrdtPurged: true, vaultId: "v", vaultName: "n" });
		const store = await PluginDataStore.open(d.io);

		await store.update((r) => {
			delete r.vaultId;
			delete r.vaultName;
		});

		expect(Object.keys(d.peek())).toEqual(["legacyCrdtPurged"]);
	});

	it("a one-shot migration flag survives writes from every other key", async () => {
		const d = fakeDisk({ legacyCrdtPurged: true });
		const store = await PluginDataStore.open(d.io);

		await Promise.all([
			store.update((r) => {
				r.sync = { lastSeq: 4, knownServer: [] };
			}),
			store.update((r) => {
				r.pending = { deletes: ["x.md"] };
			}),
			store.update((r) => {
				delete r.vaultId;
			}),
		]);

		// Losing it re-runs the legacy purge, which discards CRDT lineage and costs `(conflicted copy)` files.
		expect(d.peek().legacyCrdtPurged).toBe(true);
	});
});

describe("PluginDataStore: slices", () => {
	it("hands out a copy, so a persister mutating its own object does not touch the record", async () => {
		const d = fakeDisk({ binary: { known: { "a.png": { etag: "e", hash: "h" } } } });
		const store = await PluginDataStore.open(d.io);
		const slice = store.slice("binary");

		const mine = slice.get();
		mine!.known["b.png"] = { etag: "e2", hash: "h2" };

		expect(
			store.read().binary?.known["b.png"],
			"aliasing the record makes persist() stop being the commit point",
		).toBeUndefined();
	});

	it("copies on the way in, so mutating after set() does not reach the record", async () => {
		const d = fakeDisk();
		const store = await PluginDataStore.open(d.io);
		const slice = store.slice("pending");

		const mine = { deletes: ["a.md"] };
		await slice.set(mine);
		mine.deletes.push("b.md"); // the persister carries on mutating its own copy

		expect(store.read().pending?.deletes).toEqual(["a.md"]);
		expect(d.peek().pending?.deletes).toEqual(["a.md"]);
	});

	it("reads back what it wrote, and undefined for a key that is not there", async () => {
		const d = fakeDisk();
		const store = await PluginDataStore.open(d.io);
		expect(store.slice("sync").get()).toBeUndefined();

		await store.slice("sync").set({ lastSeq: 9, knownServer: ["a.md"] });
		expect(store.slice("sync").get()).toEqual({ lastSeq: 9, knownServer: ["a.md"] });
		expect(d.peek().sync).toEqual({ lastSeq: 9, knownServer: ["a.md"] });
	});
});

describe("PluginDataStore: an external change to the file", () => {
	it("adopts the folder's keys another copy changed", async () => {
		const d = fakeDisk({ vaultId: "vlt-1", vaultName: "Old" });
		const store = await PluginDataStore.open(d.io);

		d.externalWrite({ vaultId: "vlt-2", vaultName: "New" });
		await store.reloadExternal();

		expect(store.read().vaultId).toBe("vlt-2");
		expect(store.read().vaultName).toBe("New");
	});

	it("does NOT adopt another device's sync cursor or queues", async () => {
		// `deviceId` used to be in this list. N5 moved it out of `data.json` entirely, which is a stronger
		// fix than refusing to adopt it: a field that is not in the file cannot travel with a copy of it.
		const d = fakeDisk({ sync: { lastSeq: 2, knownServer: [] } });
		const store = await PluginDataStore.open(d.io);

		d.externalWrite({
			sync: { lastSeq: 900, knownServer: ["theirs.md"] },
			binary: { known: { "theirs.png": { etag: "e", hash: "h" } } },
			pending: { deletes: ["theirs.md"] },
			binaryPending: { deletes: [] },
		});
		await store.reloadExternal();

		// Adopting lastSeq would skip journal frames this client never applied; adopting binary.known
		// would skip pulls for files it does not have.
		expect(store.read().sync).toEqual({ lastSeq: 2, knownServer: [] });
		expect(store.read().binary).toBeUndefined();
		expect(store.read().pending).toBeUndefined();
	});

	it("does not clobber an adopted key on the next write", async () => {
		const d = fakeDisk({ legacyCrdtPurged: true });
		const store = await PluginDataStore.open(d.io);

		d.externalWrite({ legacyCrdtPurged: true, vaultId: "adopted", vaultName: "Adopted" });
		await store.reloadExternal();
		await store.update((r) => {
			r.vaultName = "Mine";
		});

		expect(
			d.peek().vaultId,
			"caching without a reload silently destroys another copy's fields",
		).toBe("adopted");
		expect(d.peek().vaultName).toBe("Mine");
	});
});

/**
 * ⛔ Audit NV33: a sign-in in `data.json` is exposed, so it is taken off the disk and handed over for
 * revocation, never used. Builds before 1.1.0 kept it there; a device still on one keeps writing it.
 */
describe("⛔ PluginDataStore: a sign-in found in the file (NV33)", () => {
	const LEGACY = { access_token: "DUMMY-ACCESS", refresh_token: "DUMMY-REFRESH" };

	it("hands this device's old sign-in over at load, and takes it off the disk", async () => {
		const d = fakeDisk({ tokens: LEGACY, clientId: "cid", vaultId: "vlt-1" });
		const found: LegacyCredential[] = [];
		const store = await PluginDataStore.open(d.io, (c) => found.push(c));

		expect(found).toEqual([{ tokens: LEGACY, clientId: "cid" }]);
		expect(d.peek()).toEqual({ vaultId: "vlt-1" });
		expect(JSON.stringify(d.peek())).not.toContain("DUMMY");
		expect("tokens" in store.read()).toBe(false);
	});

	it("writes nothing at load when the file holds no sign-in", async () => {
		const d = fakeDisk({ vaultId: "vlt-1" });
		const found: LegacyCredential[] = [];
		await PluginDataStore.open(d.io, (c) => found.push(c));
		expect(found).toEqual([]);
		expect(d.save).not.toHaveBeenCalled();
	});

	it("never adopts one another device writes in, hands it over, and takes it off the disk", async () => {
		const d = fakeDisk({ vaultId: "v" });
		const found: LegacyCredential[] = [];
		const store = await PluginDataStore.open(d.io, (c) => found.push(c));

		d.externalWrite({
			vaultId: "v",
			tokens: { access_token: "theirs", refresh_token: "their-rt" },
			clientId: "cid",
		});
		await store.reloadExternal();

		expect("tokens" in store.read()).toBe(false);
		expect(found).toEqual([
			{ tokens: { access_token: "theirs", refresh_token: "their-rt" }, clientId: "cid" },
		]);
		expect(d.peek()).toEqual({ vaultId: "v" });
	});

	it("takes a stray client id off the disk too, with nothing to revoke", async () => {
		const d = fakeDisk({ clientId: "self-registered-by-an-older-build", vaultId: "v" });
		const found: LegacyCredential[] = [];
		await PluginDataStore.open(d.io, (c) => found.push(c));
		expect(found).toEqual([]);
		expect(d.peek()).toEqual({ vaultId: "v" });
	});
});
