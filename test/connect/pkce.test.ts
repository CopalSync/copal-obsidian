import { describe, expect, it } from "vitest";
import { createPkce } from "../../src/connect/pkce";

describe("createPkce", () => {
	it("produces a base64url verifier and an S256 challenge", async () => {
		const { verifier, challenge } = await createPkce();
		expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43,}$/);
		expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
		expect(challenge).not.toContain("=");
		// The challenge is the S256 of the verifier: recompute and compare.
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		const expected = Buffer.from(new Uint8Array(digest)).toString("base64url");
		expect(challenge).toBe(expected);
	});

	it("is random per call", async () => {
		const a = await createPkce();
		const b = await createPkce();
		expect(a.verifier).not.toBe(b.verifier);
	});
});
