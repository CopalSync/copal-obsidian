import type { TokenStore } from "./store";
import type { RevokeOutcome, RevokeScope, TokenManager } from "./token-manager";

/**
 * Narrowed to the two things a teardown touches, so a test can drive the ordering with fakes instead
 * of standing up a `TokenManager` and a network.
 */
export interface TearDownDeps {
	tokens: Pick<TokenManager, "revokeAndAbandon" | "abandon">;
	store: Pick<TokenStore, "signOut">;
	/**
	 * `"none"` where the credential is already known dead (a terminal refresh failure): the race still
	 * has to be closed, but a round trip for a token the server has already discarded is a pointless
	 * call on a path usually taken because the network is misbehaving.
	 *
	 * `"token"` for sign-out and `"grant"` for disconnect — see `RevokeScope`.
	 */
	revoke: RevokeScope | "none";
}

/**
 * Give up a credential: kill it at the authorization server, then delete it locally.
 *
 * ⛔ **THIS LIVES OUTSIDE `main.ts` ON PURPOSE.** `main.ts` is ~880 lines, imports a dozen Obsidian
 * symbols the test stub does not provide, and **no test imports it**. That is the reason F2 (sign-out
 * never revoked) and C14 (an in-flight refresh resurrecting the tokens) both survived a suite whose
 * assertions were individually correct: the ordering that matters was only ever expressed in an
 * untestable file. The ordering now lives here, where `sign-out.test.ts` drives it.
 *
 * The order is the security property, and each step earns its place:
 *  1. Revoke (or at least abandon) FIRST. It needs the refresh token, which step 2 deletes, and it
 *     must invalidate anything in flight before that write can land.
 *  2. Delete locally, in a `finally`, so it happens whatever step 1 did. A sign-out that leaves the
 *     user signed in because revocation failed is a worse bug than the one revocation fixes.
 */
export async function tearDownCredential(deps: TearDownDeps): Promise<RevokeOutcome> {
	try {
		if (deps.revoke === "none") {
			await deps.tokens.abandon();
			return "nothing-to-revoke";
		}
		return await deps.tokens.revokeAndAbandon(deps.revoke);
	} finally {
		await deps.store.signOut();
	}
}
