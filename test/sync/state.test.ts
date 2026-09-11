import { describe, expect, it } from "vitest";
import { type SyncData, SyncState } from "../../src/sync/state";

function mem(initial: SyncData | null = null) {
	let data = initial;
	return {
		load: () => Promise.resolve(data),
		save: (d: SyncData) => {
			data = d;
			return Promise.resolve();
		},
		peek: () => data,
	};
}

describe("SyncState", () => {
	it("starts empty and round-trips lastSeq + knownServer through persist()", async () => {
		const m = mem();
		const s = new SyncState(m.load, m.save);
		await s.init();
		expect(s.lastSeq).toBe(0);
		expect(s.knownServer).toEqual([]);
		s.lastSeq = 5;
		s.knownServer = ["a.md", "b.md"];
		await s.persist();
		expect(m.peek()).toEqual({ lastSeq: 5, knownServer: ["a.md", "b.md"] });
	});

	it("loads an existing cursor on init", async () => {
		const s = new SyncState(mem({ lastSeq: 3, knownServer: ["x.md"] }).load, () =>
			Promise.resolve(),
		);
		await s.init();
		expect(s.lastSeq).toBe(3);
		expect(s.knownServer).toEqual(["x.md"]);
	});

	it("reset() zeroes the cursor + knownServer and persists (clean disconnect)", async () => {
		const m = mem({ lastSeq: 9, knownServer: ["a.md", "b.md"] });
		const s = new SyncState(m.load, m.save);
		await s.init();
		await s.reset();
		expect(s.lastSeq).toBe(0);
		expect(s.knownServer).toEqual([]);
		expect(m.peek()).toEqual({ lastSeq: 0, knownServer: [] });
	});

	it("back-compat: a pre-upgrade record without knownServer loads as []", async () => {
		// Older data.json `sync` records only had `{ lastSeq }`.
		const s = new SyncState(mem({ lastSeq: 4 } as SyncData).load, () => Promise.resolve());
		await s.init();
		expect(s.lastSeq).toBe(4);
		expect(s.knownServer).toEqual([]);
	});
});
