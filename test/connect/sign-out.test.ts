import { describe, expect, it, vi } from "vitest";
import { tearDownCredential } from "../../src/connect/sign-out";
import type { RevokeOutcome } from "../../src/connect/token-manager";

function fakes(outcome: RevokeOutcome | Error) {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			tokens: {
				revokeAndAbandon: vi.fn(async (_scope?: unknown) => {
					calls.push("revoke");
					if (outcome instanceof Error) throw outcome;
					return outcome;
				}),
				abandon: vi.fn(async () => {
					calls.push("abandon");
				}),
			},
			store: {
				signOut: vi.fn(async () => {
					calls.push("local-delete");
				}),
			},
		},
	};
}

describe("tearDownCredential", () => {
	it("revokes before deleting locally, because the delete destroys the token to revoke", async () => {
		const { calls, deps } = fakes("revoked");
		expect(await tearDownCredential({ ...deps, revoke: "token" })).toBe("revoked");
		expect(calls).toEqual(["revoke", "local-delete"]);
	});

	/*
	 * ⛔ The one that protects the user from this change. Revocation crosses the network; sign-out must
	 * not. If this ever regresses, someone who signs out on a train stays signed in.
	 */
	it("still deletes locally when revocation reports failure", async () => {
		const { calls, deps } = fakes("failed");
		expect(await tearDownCredential({ ...deps, revoke: "token" })).toBe("failed");
		expect(calls).toEqual(["revoke", "local-delete"]);
	});

	it("still deletes locally when revocation throws outright", async () => {
		const { calls, deps } = fakes(new Error("boom"));
		await expect(tearDownCredential({ ...deps, revoke: "token" })).rejects.toThrow("boom");
		// The throw propagates (the caller logs it), but the credential is gone from disk regardless.
		expect(calls).toEqual(["revoke", "local-delete"]);
	});

	it("passes the scope through, so disconnect can take the consent as well as the token", async () => {
		const { deps } = fakes("revoked");
		await tearDownCredential({ ...deps, revoke: "grant" });
		expect(deps.tokens.revokeAndAbandon).toHaveBeenCalledWith("grant");
	});

	it("abandons without a network call when the credential is already dead", async () => {
		const { calls, deps } = fakes("revoked");
		expect(await tearDownCredential({ ...deps, revoke: "none" })).toBe("nothing-to-revoke");
		expect(calls).toEqual(["abandon", "local-delete"]);
		expect(deps.tokens.revokeAndAbandon).not.toHaveBeenCalled();
	});
});
