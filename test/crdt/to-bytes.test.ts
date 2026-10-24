// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { toBytes } from "../../src/crdt/y-sync";

/**
 * ROADMAP G13.
 *
 * ⛔ This file runs under jsdom ON PURPOSE, and it is the only reason it does. vitest's jsdom
 * environment is a separate JavaScript realm, so a buffer made by Node's `TextEncoder` is NOT an
 * `instanceof` the jsdom `ArrayBuffer` global — which is the exact shape of the bug, available here for
 * free. Obsidian runs multiple windows and ships `Node.instanceOf()` for the same reason, so this is a
 * production condition, not a test artefact.
 *
 * The old dispatch (`data instanceof ArrayBuffer`) fell through to the ArrayBufferView branch, read
 * `undefined` for `.buffer`/`.byteOffset`/`.byteLength`, and returned a **length-0** Uint8Array. A frame
 * that decoded to nothing, silently — no throw to notice.
 */
describe("toBytes", () => {
	it("decodes a CROSS-REALM ArrayBuffer, which instanceof gets wrong", () => {
		const foreign = new TextEncoder().encode("ab").buffer;
		// The premise of the test, asserted so it cannot quietly stop being true.
		expect(foreign instanceof ArrayBuffer, "jsdom realm boundary — the condition under test").toBe(
			false,
		);
		expect(toBytes(foreign as ArrayBuffer).length, "a silent length-0 decode is the bug").toBe(2);
		expect([...toBytes(foreign as ArrayBuffer)]).toEqual([97, 98]);
	});

	it("decodes a same-realm ArrayBuffer", () => {
		const buf = new ArrayBuffer(3);
		new Uint8Array(buf).set([1, 2, 3]);
		expect([...toBytes(buf)]).toEqual([1, 2, 3]);
	});

	it("decodes a view, honouring its offset and length rather than the whole buffer", () => {
		const backing = new Uint8Array([9, 1, 2, 3, 9]);
		const view = new Uint8Array(backing.buffer, 1, 3);
		expect([...toBytes(view)]).toEqual([1, 2, 3]);
	});

	it("decodes a cross-realm VIEW too", () => {
		const foreign = new TextEncoder().encode("xyz");
		expect(foreign instanceof Uint8Array).toBe(false);
		expect([...toBytes(foreign)]).toEqual([120, 121, 122]);
	});

	it("treats a string payload as nothing, since the protocol is binary", () => {
		expect(toBytes("not binary").length).toBe(0);
	});
});
