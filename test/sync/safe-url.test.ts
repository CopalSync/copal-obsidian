import { describe, expect, it } from "vitest";
import { assertWssUrl } from "../../src/sync/safe-url";

describe("assertWssUrl", () => {
	it("accepts a wss:// URL", () => {
		expect(() => assertWssUrl("wss://api.copal.uk/sync?ticket=x")).not.toThrow();
	});

	for (const bad of [
		"ws://api.copal.uk",
		"http://api.copal.uk",
		"https://api.copal.uk",
		"",
		"wssx://x",
		" wss://x",
	]) {
		it(`rejects ${JSON.stringify(bad)}`, () => {
			expect(() => assertWssUrl(bad)).toThrow(/wss/);
		});
	}
});
