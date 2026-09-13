import { describe, expect, it } from "vitest";
import { PathQueue } from "../../src/crdt/path-queue";

/** A job that parks until released, recording how many times it was entered. */
function gatedJob() {
	const entered: number[] = [];
	const releases: (() => void)[] = [];
	let n = 0;
	const job = (): Promise<void> => {
		entered.push(++n);
		return new Promise<void>((resolve) => releases.push(resolve));
	};
	return {
		job,
		calls: () => entered.length,
		release: (i = 0) => releases[i]?.(),
		releaseAll: () => {
			for (const r of releases.splice(0)) r();
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PathQueue", () => {
	it("runs a job immediately when the path is idle", async () => {
		const q = new PathQueue();
		const g = gatedJob();
		const p = q.run("a.md", g.job);
		await tick();
		expect(g.calls()).toBe(1);
		g.releaseAll();
		await p;
	});

	it("collapses a burst into ONE re-run behind the in-flight job", async () => {
		const q = new PathQueue();
		const g = gatedJob();

		const first = q.run("a.md", g.job);
		await tick();
		expect(g.calls(), "the first job should be running").toBe(1);

		// Three more edits arrive while the first is still in flight.
		const rest = [q.run("a.md", g.job), q.run("a.md", g.job), q.run("a.md", g.job)];
		await tick();
		expect(g.calls(), "a queued job must not start while one is running").toBe(1);

		g.release(0); // the in-flight one finishes → exactly one re-run picks up the final state
		await tick();
		expect(g.calls(), "a burst of three should collapse into one re-run").toBe(2);

		g.releaseAll();
		await Promise.all([first, ...rest]);
	});

	it("resolves every queued caller when the re-run completes", async () => {
		const q = new PathQueue();
		const g = gatedJob();
		const first = q.run("a.md", g.job);
		await tick();
		const second = q.run("a.md", g.job);
		const third = q.run("a.md", g.job);
		g.releaseAll();
		await tick();
		g.releaseAll();
		await expect(Promise.all([first, second, third])).resolves.toBeDefined();
	});

	it("coalesce rides an in-flight run instead of queueing another", async () => {
		const q = new PathQueue();
		const g = gatedJob();
		const first = q.run("a.md", g.job);
		await tick();

		const rider = q.coalesce("a.md", g.job);
		await tick();
		expect(g.calls(), "coalesce must not start a second run").toBe(1);

		g.releaseAll();
		await Promise.all([first, rider]);
		expect(g.calls(), "coalesce must not queue a re-run either").toBe(1);
	});

	it("keeps different paths independent", async () => {
		const q = new PathQueue();
		const a = gatedJob();
		const b = gatedJob();
		const pa = q.run("a.md", a.job);
		const pb = q.run("b.md", b.job);
		await tick();
		expect([a.calls(), b.calls()]).toEqual([1, 1]);
		a.releaseAll();
		b.releaseAll();
		await Promise.all([pa, pb]);
	});

	it("a job that throws still releases the path and runs what was queued", async () => {
		const q = new PathQueue();
		let calls = 0;
		const boom = (): Promise<void> => {
			calls += 1;
			return Promise.reject(new Error("boom"));
		};
		const first = q.run("a.md", boom);
		const queued = q.run("a.md", boom);

		await expect(first).rejects.toThrow("boom");
		await expect(queued).rejects.toThrow("boom");
		expect(calls, "the queued job never ran after the first one threw").toBe(2);
	});

	it("drain waits for the queued job as well as the running one", async () => {
		const q = new PathQueue();
		const g = gatedJob();
		const first = q.run("a.md", g.job);
		await tick();
		const queued = q.run("a.md", g.job);

		let drained = false;
		const d = q.drain("a.md").then(() => (drained = true));

		g.release(0);
		await tick();
		expect(drained, "drain resolved while a queued job was still to run").toBe(false);

		g.releaseAll();
		await d;
		expect(drained).toBe(true);
		await Promise.all([first, queued]);
	});
});
