// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDeviceId, deviceId } from "../../src/connect/device-id";

/**
 * ROADMAP N5. jsdom because `localStorage` IS the subject.
 */
beforeEach(() => {
	__resetDeviceId();
	localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("deviceId", () => {
	it("mints one and remembers it in localStorage, not in the vault", () => {
		// ⛔ The whole point: `data.json` travels with a synced vault, so an id kept there is shared
		// between devices — and P5's echo filter then makes device B discard device A's changes.
		const first = deviceId();
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(localStorage.getItem("copal-device-id")).toBe(first);
	});

	it("is stable across calls", () => {
		expect(deviceId()).toBe(deviceId());
	});

	it("is stable across sessions, reading back what localStorage kept", () => {
		const first = deviceId();
		__resetDeviceId(); // a fresh plugin load
		expect(deviceId()).toBe(first);
	});

	it("gives two installs DIFFERENT ids even from the same vault contents", () => {
		// The copied-vault case. Same `data.json`, different device: the ids must diverge.
		const a = deviceId();
		__resetDeviceId();
		localStorage.clear(); // the other device has its own storage
		const b = deviceId();
		expect(b, "a shared id makes the echo filter eat the other device's edits").not.toBe(a);
	});

	it("stays stable within a session even when localStorage cannot be written", () => {
		// ⚠️ Without the memory cache this would mint a new id on every call, and the echo filter would
		// never match anything — a subtler version of the same bug.
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		const first = deviceId();
		expect(deviceId()).toBe(first);
		expect(deviceId()).toBe(first);
	});

	it("survives localStorage throwing on READ", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(deviceId()).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("ignores an empty stored value rather than using it", () => {
		localStorage.setItem("copal-device-id", "");
		expect(deviceId()).not.toBe("");
	});
});
