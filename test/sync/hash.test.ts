import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/sync/hash";

describe("contentHash", () => {
	it("is a base64url SHA-256 of the content", async () => {
		const h = await contentHash("hello");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hello"));
		expect(h).toBe(Buffer.from(new Uint8Array(digest)).toString("base64url"));
		expect(h).toMatch(/^[A-Za-z0-9\-_]+$/);
	});

	it("is stable for identical content and differs for different content", async () => {
		expect(await contentHash("same")).toBe(await contentHash("same"));
		expect(await contentHash("a")).not.toBe(await contentHash("b"));
	});
});
