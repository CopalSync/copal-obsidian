import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PageEntry, SyncPager } from "../../src/crdt/sync-pager";

/**
 * P1's client-side batching. The properties under test are the ones that make a first import both fast
 * and lossless — the old path synced one note per socket and dropped edits made while it ran.
 */
const makePager = (
	drain: (entries: PageEntry[]) => Promise<void>,
	opts: { pageSize?: number; debounceMs?: number } = {},
) => new SyncPager({ drain, pageSize: opts.pageSize ?? 100, debounceMs: opts.debounceMs ?? 300 });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Let the debounce fire and every awaited microtask inside the drain settle. */
const tick = async (ms = 300) => {
	await vi.advanceTimersByTimeAsync(ms);
};

describe("SyncPager", () => {
	it("debounces a burst of notifies for one path into a single page entry", async () => {
		const pages: PageEntry[][] = [];
		const pager = makePager(async (e) => void pages.push(e));

		for (let i = 0; i < 10; i++) pager.notify("a.md", { lane: "live", readFile: true });
		expect(pages).toHaveLength(0); // nothing before the debounce elapses

		await tick();
		expect(pages).toHaveLength(1);
		expect(pages[0]).toEqual([{ path: "a.md", readFile: true, adopt: false }]);
	});

	it("OR-merges flags and upgrades a pending bulk path to live", async () => {
		const pages: PageEntry[][] = [];
		const pager = makePager(async (e) => void pages.push(e));

		pager.notify("a.md", { lane: "bulk", readFile: false });
		pager.notify("a.md", { lane: "live", readFile: true });
		await tick();

		expect(pages[0]).toEqual([{ path: "a.md", readFile: true, adopt: false }]);
	});

	/**
	 * `adopt` is remote-wins, and it must travel with the entry rather than be engine state: a live edit
	 * landing mid-adopt would otherwise inherit it and have the user's text discarded instead of kept as
	 * a conflict copy.
	 */
	it("carries adopt per entry and never leaks it onto another path", async () => {
		const pages: PageEntry[][] = [];
		const pager = makePager(async (e) => void pages.push(e), { pageSize: 10 });

		pager.notify("adopted.md", { lane: "bulk", adopt: true });
		pager.notify("mine.md", { lane: "live", readFile: true });
		await tick();

		const byPath = new Map(pages.flat().map((e) => [e.path, e]));
		expect(byPath.get("adopted.md")?.adopt).toBe(true);
		expect(byPath.get("mine.md")?.adopt).toBe(false);
	});

	it("drains live before bulk, so a user's edit never waits behind an import", async () => {
		const pages: PageEntry[][] = [];
		const pager = makePager(async (e) => void pages.push(e), { pageSize: 2 });

		pager.enqueueAll(["b1.md", "b2.md", "b3.md"], "bulk");
		pager.notify("hot.md", { lane: "live", readFile: true });
		await tick(2000);

		expect(pages[0]?.[0]?.path).toBe("hot.md");
		expect(
			pages
				.flat()
				.map((e) => e.path)
				.sort(),
		).toEqual(["b1.md", "b2.md", "b3.md", "hot.md"]);
	});

	it("runs exactly one page at a time", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const pager = makePager(
			async () => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight--;
			},
			{ pageSize: 1 },
		);

		pager.enqueueAll(["a.md", "b.md", "c.md"], "bulk");
		await tick(3000);
		expect(maxInFlight).toBe(1);
	});

	/**
	 * ⛔ The lost-edit guarantee. A notify that lands while its own path is being exchanged must be
	 * re-queued, not coalesced into the run already in flight — that run read the file before the edit
	 * existed, so treating it as covered is exactly how an edit disappears.
	 */
	it("re-queues a path notified while it is in the in-flight page", async () => {
		const pages: PageEntry[][] = [];
		const pager = makePager(async (entries) => {
			pages.push(entries);
			if (pages.length === 1) pager.notify("a.md", { lane: "live", readFile: true });
			await Promise.resolve();
		});

		pager.notify("a.md", { lane: "bulk", readFile: false });
		await tick(2000);

		expect(pages).toHaveLength(2);
		expect(pages[1]).toEqual([{ path: "a.md", readFile: true, adopt: false }]);
	});

	it("keeps the pipeline hot across pages while work is progressing", async () => {
		const pages: PageEntry[][] = [];
		const pager = makePager(async (e) => void pages.push(e), { pageSize: 10 });

		pager.enqueueAll(
			Array.from({ length: 50 }, (_, i) => `n${i}.md`),
			"bulk",
		);
		await tick(400); // ONE debounce, then five pages back to back

		expect(pages).toHaveLength(5);
		expect(new Set(pages.flat().map((e) => e.path)).size).toBe(50);
	});

	it("backs off instead of spinning when a page throws", async () => {
		let calls = 0;
		const pager = makePager(async () => {
			calls++;
			throw new Error("offline");
		});

		pager.notify("a.md", { lane: "bulk" });
		await tick(300);
		expect(calls).toBe(1);

		// The retry is delayed, and each further failure doubles it — not a 300ms hot loop.
		await tick(600);
		expect(calls).toBe(2);
		const afterTwo = calls;
		await tick(700);
		expect(calls).toBe(afterTwo); // still inside the doubled backoff
		await tick(1500);
		expect(calls).toBeGreaterThan(afterTwo);
	});

	it("re-queues the whole page when the drain throws, so nothing is lost to a dead network", async () => {
		const seen: string[][] = [];
		let fail = true;
		const pager = makePager(async (entries) => {
			seen.push(entries.map((e) => e.path));
			if (fail) throw new Error("offline");
		});

		pager.enqueueAll(["a.md", "b.md"], "bulk");
		await tick(300);
		expect(seen[0]).toEqual(["a.md", "b.md"]);

		fail = false;
		await tick(5000);
		expect([...(seen.at(-1) ?? [])].sort()).toEqual(["a.md", "b.md"]);
	});

	it("drop() removes a pending path and cancels one already in the page", async () => {
		const pages: PageEntry[][] = [];
		let cancelledDuringDrain: boolean | undefined;
		const pager = makePager(async (entries) => {
			pages.push(entries);
			if (pages.length === 1) {
				pager.drop("b.md");
				cancelledDuringDrain = pager.isCancelled("b.md");
			}
			await Promise.resolve();
		});

		pager.notify("a.md", { lane: "bulk" });
		pager.notify("b.md", { lane: "bulk" });
		await tick(2000);

		expect(cancelledDuringDrain).toBe(true);
		// Dropped mid-page → never re-queued into a later page.
		expect(
			pages
				.slice(1)
				.flat()
				.map((e) => e.path),
		).not.toContain("b.md");
	});

	it("idle() resolves only once pending is empty and nothing is in flight", async () => {
		let resolved = false;
		const pager = makePager(
			async () => {
				await Promise.resolve();
			},
			{ pageSize: 1 },
		);

		pager.enqueueAll(["a.md", "b.md"], "bulk");
		void pager.idle().then(() => {
			resolved = true;
		});

		expect(resolved).toBe(false);
		await tick(2000);
		expect(resolved).toBe(true);
	});

	it("stop() abandons queued work and lets idle() resolve", async () => {
		const pages: PageEntry[][] = [];
		const pager = makePager(async (e) => void pages.push(e));

		pager.enqueueAll(["a.md", "b.md"], "bulk");
		pager.stop();
		await pager.idle();
		await tick(2000);

		expect(pages).toHaveLength(0);
		pager.notify("c.md", { lane: "live" });
		await tick(2000);
		expect(pages).toHaveLength(0); // refuses new work too
	});
});
