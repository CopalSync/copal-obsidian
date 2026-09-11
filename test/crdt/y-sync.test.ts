import { Awareness } from "y-protocols/awareness";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyAwareness, encodeAwareness, MSG_AWARENESS, messageType } from "../../src/crdt/y-sync";

describe("y-sync awareness framing", () => {
	it("round-trips an awareness update between two peers", () => {
		const a = new Awareness(new Y.Doc());
		const b = new Awareness(new Y.Doc());
		a.setLocalStateField("user", { name: "agent" });

		const frame = encodeAwareness(a, [a.clientID]);
		expect(messageType(new Uint8Array(frame))).toBe(MSG_AWARENESS);

		applyAwareness(b, new Uint8Array(frame), "remote");
		const state = b.getStates().get(a.clientID) as { user?: { name?: string } } | undefined;
		expect(state?.user?.name).toBe("agent");
	});
});
