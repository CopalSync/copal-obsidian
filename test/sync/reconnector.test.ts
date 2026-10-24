// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reconnector, type ReconnectorOptions } from "../../src/sync/reconnector";

/**
 * ROADMAP P8. jsdom because the offline and visibility behaviour IS the row — `navigator.onLine`,
 * `online` and `visibilitychange` cannot be exercised under the node environment at all.
 */
function onLine(value: boolean): void {
	Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

let reconnectors: Reconnector[] = [];
function make(opts: Partial<ReconnectorOptions> = {}) {
	const connect = vi.fn();
	const onAuthFailure = vi.fn();
	const r = new Reconnector({ baseMs: 1000, capMs: 15000, connect, onAuthFailure, ...opts });
	reconnectors.push(r);
	return { r, connect, onAuthFailure };
}

beforeEach(() => {
	reconnectors = [];
	onLine(true);
	vi.useFakeTimers();
});
afterEach(() => {
	for (const r of reconnectors) r.stop();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("backoff", () => {
	it("doubles per consecutive failure and stops at the cap", () => {
		const { r } = make();
		vi.spyOn(Math, "random").mockReturnValue(1); // remove jitter to see the curve exactly
		expect(r.delayFor(0)).toBe(1000);
		expect(r.delayFor(1)).toBe(2000);
		expect(r.delayFor(2)).toBe(4000);
		expect(r.delayFor(10), "capped, not unbounded").toBe(15000);
	});

	it("jitters, so clients that dropped together do not return together", () => {
		// ⛔ The point of the row. Without jitter every client that dropped on one server blip comes back
		// in the same millisecond, which is how a recovering server is knocked over by its own clients.
		const { r } = make();
		const delays = new Set(Array.from({ length: 40 }, () => r.delayFor(3)));
		expect(delays.size, "a fixed delay is a thundering herd").toBeGreaterThan(5);
		for (const d of delays) {
			expect(d).toBeLessThanOrEqual(8000);
			expect(d).toBeGreaterThanOrEqual(8000 * 0.7 - 1);
		}
	});

	it("a success resets the curve", () => {
		const { r, connect } = make();
		r.schedule();
		vi.advanceTimersByTime(2000);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(r.attempts).toBe(1);
		r.succeeded();
		expect(r.attempts).toBe(0);
	});

	it("a SCHEDULED retirement resets the curve without counting a failure", () => {
		// ⚠️ The gateway retires every socket after 30 minutes by design. A note left open all day would
		// otherwise walk to the 15s cap through nothing but healthy rotations, and then a real drop would
		// wait the whole cap to recover.
		const { r } = make();
		r.schedule();
		vi.advanceTimersByTime(2000);
		expect(r.attempts).toBe(1);
		r.scheduledRetirement();
		expect(r.attempts).toBe(0);
	});

	it("does not stack timers when schedule is called twice", () => {
		const { r, connect } = make();
		r.schedule();
		r.schedule();
		vi.advanceTimersByTime(20000);
		expect(connect).toHaveBeenCalledTimes(1);
	});
});

describe("offline awareness", () => {
	it("does not even schedule while the device says it is offline", () => {
		// Retrying while offline is guaranteed to fail, and on a phone the radio and the battery pay.
		onLine(false);
		const { r, connect } = make();
		r.schedule();
		vi.advanceTimersByTime(60000);
		expect(connect).not.toHaveBeenCalled();
	});

	it("reconnects IMMEDIATELY when the device comes back, not after the backoff", () => {
		// ⛔ The behaviour a user actually notices: coming back onto wifi and waiting 15s for a client
		// that already knows it is online.
		onLine(false);
		const { r, connect } = make();
		r.schedule();
		expect(connect).not.toHaveBeenCalled();

		onLine(true);
		window.dispatchEvent(new Event("online"));
		expect(connect, "no timer should have to elapse").toHaveBeenCalledTimes(1);
	});

	it("cancels a pending backoff timer when it wakes, rather than connecting twice", () => {
		const { r, connect } = make();
		r.schedule(); // online, so a timer is pending
		window.dispatchEvent(new Event("online"));
		expect(connect).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60000);
		expect(connect, "the superseded timer must not fire as well").toHaveBeenCalledTimes(1);
	});

	it("an `online` event with nothing pending connects nothing", () => {
		const { connect } = make();
		window.dispatchEvent(new Event("online"));
		expect(connect).not.toHaveBeenCalled();
	});

	it("a wake does NOT reset the backoff, so a flapping network still slows down", () => {
		// ⚠️ A wake is evidence that conditions changed, not that the server is healthy.
		const { r } = make();
		r.schedule();
		vi.advanceTimersByTime(2000);
		expect(r.attempts).toBe(1);
		r.schedule();
		window.dispatchEvent(new Event("online"));
		expect(r.attempts, "the curve must keep growing while it keeps failing").toBe(2);
	});
});

describe("visibility awareness", () => {
	it("reconnects when a backgrounded app becomes visible again", () => {
		onLine(false);
		const { r, connect } = make();
		r.schedule();
		onLine(true);
		Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("ignores becoming HIDDEN", () => {
		const { r, connect } = make();
		onLine(false);
		r.schedule();
		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		expect(connect).not.toHaveBeenCalled();
	});
});

describe("auth failure", () => {
	it("stops retrying and tells the caller — a 401 does not get better by waiting", () => {
		// ⛔ The credential is the problem, so the only layer that can fix it is the one that can ask the
		// user to sign in again. Looping at 15s for ever instead is a client that looks broken.
		const { r, connect, onAuthFailure } = make();
		r.authFailed();
		expect(onAuthFailure).toHaveBeenCalledOnce();
		r.schedule();
		vi.advanceTimersByTime(60000);
		expect(connect, "no further attempts after an auth failure").not.toHaveBeenCalled();
	});

	it("stays stopped across a wake", () => {
		const { r, connect } = make();
		r.authFailed();
		window.dispatchEvent(new Event("online"));
		expect(connect).not.toHaveBeenCalled();
	});
});

describe("stop", () => {
	it("cancels the pending attempt and releases its listeners", () => {
		const { r, connect } = make();
		r.schedule();
		r.stop();
		vi.advanceTimersByTime(60000);
		expect(connect).not.toHaveBeenCalled();
		window.dispatchEvent(new Event("online"));
		expect(connect).not.toHaveBeenCalled();
	});

	it("is idempotent", () => {
		const { r } = make();
		r.stop();
		expect(() => r.stop()).not.toThrow();
	});
});
