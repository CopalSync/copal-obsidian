import { describe, expect, it } from "vitest";
import { memSlice } from "../data/fake-plugin-data";
import { type MutationData, MutationQueue } from "../../src/sync/mutation-queue";

const mem = (initial: MutationData | null = null) => memSlice("pending", initial ?? undefined);

describe("MutationQueue", () => {
	it("starts empty and round-trips queued deletes through persist()", async () => {
		const m = await mem();
		const q = new MutationQueue(m.slice);
		await q.init();
		expect(q.list()).toEqual([]);
		q.enqueueDelete("a.md");
		q.enqueueDelete("b.md");
		await q.persist();
		expect(m.peek()).toEqual({ deletes: ["a.md", "b.md"] });
	});

	it("enqueueDelete dedups by path (a delete is idempotent by identity)", async () => {
		const q = new MutationQueue((await mem()).slice);
		await q.init();
		q.enqueueDelete("a.md");
		q.enqueueDelete("a.md");
		expect(q.list()).toEqual(["a.md"]);
	});

	it("dequeue removes a single path", async () => {
		const q = new MutationQueue((await mem()).slice);
		await q.init();
		q.enqueueDelete("a.md");
		q.enqueueDelete("b.md");
		q.dequeue("a.md");
		expect(q.list()).toEqual(["b.md"]);
	});

	it("loads an existing queue on init (survives a reload)", async () => {
		const q = new MutationQueue((await mem({ deletes: ["x.md", "y.md"] })).slice);
		await q.init();
		expect(q.list()).toEqual(["x.md", "y.md"]);
	});

	it("reset() clears the queue and persists", async () => {
		const m = await mem({ deletes: ["a.md"] });
		const q = new MutationQueue(m.slice);
		await q.init();
		await q.reset();
		expect(q.list()).toEqual([]);
		expect(m.peek()).toEqual({ deletes: [] });
	});

	it("back-compat: an absent/null record loads as an empty queue", async () => {
		const q = new MutationQueue((await mem(null)).slice);
		await q.init();
		expect(q.list()).toEqual([]);
	});
});
