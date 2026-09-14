import { describe, expect, it } from "vitest";
import { memSlice } from "../data/fake-plugin-data";
import { type SyncData, SyncState } from "../../src/sync/state";

const mem = (initial: SyncData | null = null) => memSlice("sync", initial ?? undefined);

describe("SyncState", () => {
	it("starts empty and round-trips lastSeq + knownServer through persist()", async () => {
		const m = await mem();
		const s = new SyncState(m.slice);
		await s.init();
		expect(s.lastSeq).toBe(0);
		expect(s.knownServer).toEqual([]);
		s.lastSeq = 5;
		s.knownServer = ["a.md", "b.md"];
		await s.persist();
		expect(m.peek()).toEqual({ lastSeq: 5, knownServer: ["a.md", "b.md"] });
	});

	it("loads an existing cursor on init", async () => {
		const s = new SyncState((await mem({ lastSeq: 3, knownServer: ["x.md"] })).slice);
		await s.init();
		expect(s.lastSeq).toBe(3);
		expect(s.knownServer).toEqual(["x.md"]);
	});

	it("reset() zeroes the cursor + knownServer and persists (clean disconnect)", async () => {
		const m = await mem({ lastSeq: 9, knownServer: ["a.md", "b.md"] });
		const s = new SyncState(m.slice);
		await s.init();
		await s.reset();
		expect(s.lastSeq).toBe(0);
		expect(s.knownServer).toEqual([]);
		expect(m.peek()).toEqual({ lastSeq: 0, knownServer: [] });
	});

	it("back-compat: a pre-upgrade record without knownServer loads as []", async () => {
		// Older data.json `sync` records only had `{ lastSeq }`.
		const s = new SyncState((await mem({ lastSeq: 4 } as SyncData)).slice);
		await s.init();
		expect(s.lastSeq).toBe(4);
		expect(s.knownServer).toEqual([]);
	});
});
