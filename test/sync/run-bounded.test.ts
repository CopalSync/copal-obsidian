import { describe, expect, it } from "vitest";
import { fnv1a, fnv1aChunked } from "../../src/sync/fnv";
import { runBounded, runWithinBudget, type SizedTask } from "../../src/sync/run-bounded";

const MB = 1024 * 1024;

describe("fnv1aChunked", () => {
	it("gives byte-identical output to fnv1a, at every chunk boundary", async () => {
		// The hash is a fold, so chunking cannot change it — but that is exactly the kind of claim that
		// quietly stops being true. The boundary is 256 KiB, so these straddle it in both directions.
		for (const n of [0, 1, 255, 1024, 256 * 1024 - 1, 256 * 1024, 256 * 1024 + 1, 700 * 1024]) {
			const bytes = new Uint8Array(n);
			for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
			expect(await fnv1aChunked(bytes), `length ${n}`).toBe(fnv1a(bytes));
		}
	});

	it("yields between chunks, so a large file does not block the thread in one go", async () => {
		// ⚠️ Asserting the yield, not just the result. Obsidian's UI runs on this thread, so the
		// synchronous fold froze the window for the whole of a 90 MB file.
		let turns = 0;
		const tick = (): void => {
			turns += 1;
			if (turns < 50) void Promise.resolve().then(tick);
		};
		void Promise.resolve().then(tick);
		await fnv1aChunked(new Uint8Array(900 * 1024)); // ~4 chunks
		expect(turns, "other work must have been able to run during the hash").toBeGreaterThan(1);
	});
});

describe("runBounded", () => {
	it("runs everything, never more than `limit` at once", async () => {
		let inFlight = 0;
		let peak = 0;
		const thunks = Array.from({ length: 20 }, () => async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await Promise.resolve();
			inFlight -= 1;
		});
		await runBounded(3, thunks);
		expect(peak).toBeLessThanOrEqual(3);
		expect(inFlight).toBe(0);
	});

	it("a throwing thunk does not stop the rest", async () => {
		const done: number[] = [];
		await runBounded(2, [
			async () => {
				throw new Error("boom");
			},
			async () => void done.push(2),
			async () => void done.push(3),
		]);
		expect(done).toEqual([2, 3]);
	});
});

describe("runWithinBudget", () => {
	function sized(sizes: number[]) {
		let inFlightBytes = 0;
		let peakBytes = 0;
		let inFlight = 0;
		let peakCount = 0;
		const gates: (() => void)[] = [];
		const tasks: SizedTask[] = sizes.map((bytes) => ({
			bytes,
			run: async () => {
				inFlightBytes += bytes;
				inFlight += 1;
				peakBytes = Math.max(peakBytes, inFlightBytes);
				peakCount = Math.max(peakCount, inFlight);
				await new Promise<void>((r) => gates.push(r));
				inFlightBytes -= bytes;
				inFlight -= 1;
			},
		}));
		return {
			tasks,
			peak: () => peakBytes,
			peakCount: () => peakCount,
			releaseAll: async () => {
				// Drain repeatedly: releasing admits more work, which parks again.
				for (let i = 0; i < 50; i++) {
					const pending = gates.splice(0, gates.length);
					for (const g of pending) g();
					await new Promise((r) => setTimeout(r, 0));
				}
			},
		};
	}

	it("never exceeds the byte budget, even well under the concurrency limit", async () => {
		// ⛔ The fault a count-based limit cannot see: six concurrent 90 MB attachments is 540 MB
		// resident, because a count treats a 2 KB icon and a 90 MB video as one unit each.
		const h = sized([30 * MB, 30 * MB, 30 * MB, 30 * MB, 30 * MB, 30 * MB]);
		const run = runWithinBudget(6, 64 * MB, h.tasks);
		await new Promise((r) => setTimeout(r, 0));
		await h.releaseAll();
		await run;
		expect(h.peak(), "64 MB budget, 30 MB tasks → at most two at a time").toBeLessThanOrEqual(
			64 * MB,
		);
	});

	it("still honours the concurrency limit when everything is tiny", async () => {
		const h = sized(Array.from({ length: 20 }, () => 1024));
		const run = runWithinBudget(4, 64 * MB, h.tasks);
		await new Promise((r) => setTimeout(r, 0));
		await h.releaseAll();
		await run;
		expect(h.peakCount()).toBeLessThanOrEqual(4);
	});

	it("runs a single task bigger than the whole budget, alone, rather than never", async () => {
		// ⚠️ Refusing it would mean a file that can never sync, which is worse than one slow transfer.
		const h = sized([200 * MB, 1024]);
		const run = runWithinBudget(4, 64 * MB, h.tasks);
		await new Promise((r) => setTimeout(r, 0));
		await h.releaseAll();
		await run;
		expect(h.peak()).toBeGreaterThanOrEqual(200 * MB);
	});

	it("runs every task", async () => {
		const done: number[] = [];
		await runWithinBudget(
			3,
			10,
			Array.from({ length: 12 }, (_, i) => ({ bytes: 4, run: async () => void done.push(i) })),
		);
		expect(done.length).toBe(12);
	});

	it("a throwing task releases its budget rather than wedging the queue", async () => {
		const done: number[] = [];
		await runWithinBudget(1, 10, [
			{
				bytes: 9,
				run: async () => {
					throw new Error("boom");
				},
			},
			{ bytes: 9, run: async () => void done.push(2) },
		]);
		expect(done, "a leaked budget would park the next task for ever").toEqual([2]);
	});
});
