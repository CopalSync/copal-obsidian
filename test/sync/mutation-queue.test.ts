import { describe, expect, it } from "vitest";
import { type MutationData, MutationQueue } from "../../src/sync/mutation-queue";

function mem(initial: MutationData | null = null) {
	let data = initial;
	return {
		load: () => Promise.resolve(data),
		save: (d: MutationData) => {
			data = d;
			return Promise.resolve();
		},
		peek: () => data,
	};
}

describe("MutationQueue", () => {
	it("starts empty and round-trips queued deletes through persist()", async () => {
		const m = mem();
		const q = new MutationQueue(m.load, m.save);
		await q.init();
		expect(q.list()).toEqual([]);
		q.enqueueDelete("a.md");
		q.enqueueDelete("b.md");
		await q.persist();
		expect(m.peek()).toEqual({ deletes: ["a.md", "b.md"] });
	});

	it("enqueueDelete dedups by path (a delete is idempotent by identity)", async () => {
		const q = new MutationQueue(mem().load, () => Promise.resolve());
		await q.init();
		q.enqueueDelete("a.md");
		q.enqueueDelete("a.md");
		expect(q.list()).toEqual(["a.md"]);
	});

	it("dequeue removes a single path", async () => {
		const q = new MutationQueue(mem().load, () => Promise.resolve());
		await q.init();
		q.enqueueDelete("a.md");
		q.enqueueDelete("b.md");
		q.dequeue("a.md");
		expect(q.list()).toEqual(["b.md"]);
	});

	it("loads an existing queue on init (survives a reload)", async () => {
		const q = new MutationQueue(mem({ deletes: ["x.md", "y.md"] }).load, () => Promise.resolve());
		await q.init();
		expect(q.list()).toEqual(["x.md", "y.md"]);
	});

	it("reset() clears the queue and persists", async () => {
		const m = mem({ deletes: ["a.md"] });
		const q = new MutationQueue(m.load, m.save);
		await q.init();
		await q.reset();
		expect(q.list()).toEqual([]);
		expect(m.peek()).toEqual({ deletes: [] });
	});

	it("back-compat: an absent/null record loads as an empty queue", async () => {
		const q = new MutationQueue(mem(null).load, () => Promise.resolve());
		await q.init();
		expect(q.list()).toEqual([]);
	});
});
