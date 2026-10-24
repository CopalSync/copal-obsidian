import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CrdtNote, type YTransport } from "../../src/crdt/crdt-note";
import { withBudget, withTimeout } from "../../src/sync/with-timeout";

/** A transport that goes nowhere; these cases are about what is attached, not what is exchanged. */
function inertTransport(): YTransport & { sent: number } {
	const t = {
		sent: 0,
		send() {
			t.sent += 1;
		},
		onMessage: () => undefined,
		onOpen: () => undefined,
		close: () => undefined,
	};
	return t as YTransport & { sent: number };
}

/** Observer count for one event on a Yjs/lib0 Observable. */
const observers = (target: { _observers?: Map<string, Set<unknown>> }, event: string): number =>
	target._observers?.get(event)?.size ?? 0;

afterEach(() => {
	vi.useRealTimers();
});

describe("CrdtNote.disconnect releases what it attached (P7)", () => {
	/**
	 * ⛔ The doc handler is attached to the INJECTED, persisted doc, which outlives the peer by design.
	 * Every peer used to leave one behind, still firing into a transport that had been closed — so
	 * opening a series of notes accumulated a handler per note on docs the registry keeps resident.
	 */
	it("removes its doc update handler, so the persisted doc is left as it was found", () => {
		const doc = new Y.Doc();
		const before = observers(doc, "update");

		const peer = new CrdtNote(inertTransport(), doc);
		expect(observers(doc, "update")).toBe(before + 1);

		peer.disconnect();
		expect(observers(doc, "update"), "the peer left a listener on a doc it does not own").toBe(
			before,
		);
	});

	it("stops sending on the doc after disconnect, rather than writing into a closed transport", () => {
		const doc = new Y.Doc();
		const transport = inertTransport();
		const peer = new CrdtNote(transport, doc);
		doc.getText("content").insert(0, "before");
		expect(transport.sent).toBeGreaterThan(0);

		peer.disconnect();
		// ⚠️ Baseline taken AFTER disconnect: it deliberately broadcasts one presence-clear frame on the
		// way out, so peers drop our caret immediately instead of waiting out yCollab's timeout.
		const sentAfterDisconnect = transport.sent;
		doc.getText("content").insert(0, "after");
		expect(transport.sent, "an edit after disconnect still reached the transport").toBe(
			sentAfterDisconnect,
		);
	});

	it("leaves no awareness observers behind", () => {
		const doc = new Y.Doc();
		const peer = new CrdtNote(inertTransport(), doc);
		const awareness = (peer as unknown as { awareness: { _observers?: Map<string, Set<unknown>> } })
			.awareness;
		expect(observers(awareness, "update")).toBeGreaterThan(0);

		peer.disconnect();
		expect(observers(awareness, "update")).toBe(0);
		expect(observers(awareness, "change")).toBe(0);
	});

	it("does not destroy an injected doc, which the store owns", () => {
		const doc = new Y.Doc();
		const peer = new CrdtNote(inertTransport(), doc);
		peer.disconnect();
		// A destroyed doc throws on transact; this one must still be usable.
		expect(() => doc.getText("content").insert(0, "still alive")).not.toThrow();
	});
});

describe("withTimeout owns its timer", () => {
	/**
	 * ⚠️ `Promise.race([p, new Promise((r) => setTimeout(r, ms))])` leaves a live timer for the full
	 * budget every time `p` wins — which is the normal case. One per note opened.
	 */
	it("clears the timer when the work wins", async () => {
		vi.useFakeTimers();
		const result = await withTimeout(Promise.resolve("done"), 10_000);
		expect(result).toEqual({ timedOut: false, value: "done" });
		expect(vi.getTimerCount(), "a timer outlived the work it was bounding").toBe(0);
	});

	it("clears the timer when the deadline wins", async () => {
		vi.useFakeTimers();
		const pending = withTimeout(new Promise<never>(() => undefined), 50);
		await vi.advanceTimersByTimeAsync(60);
		expect(await pending).toEqual({ timedOut: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears the timer when the work rejects", async () => {
		vi.useFakeTimers();
		await expect(withTimeout(Promise.reject(new Error("nope")), 10_000)).rejects.toThrow("nope");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("withBudget falls back to the given value instead of branching", async () => {
		vi.useFakeTimers();
		const pending = withBudget(new Promise<string>(() => undefined), 50, "fallback");
		await vi.advanceTimersByTimeAsync(60);
		expect(await pending).toBe("fallback");
		expect(vi.getTimerCount()).toBe(0);
	});
});
