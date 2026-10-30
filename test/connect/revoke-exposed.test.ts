import { afterEach, describe, expect, it, vi } from "vitest";
import { revokeExposed } from "../../src/connect/revoke-exposed";
import { memCredentials } from "../data/fake-plugin-data";

/**
 * ⛔ Audit NV33: a sign-in found in the vault folder is revoked, and forgotten only once it has been.
 *
 * Every copy of the folder holds the same refresh token, so revoking it at the authorization server is
 * the one thing that makes those copies useless. Deleting it here alone would leave them able to renew
 * themselves for 14 days.
 */
const DISCOVERY = {
	issuer: "https://auth.copal.uk",
	authorization_endpoint: "https://auth.copal.uk/oauth2/authorize",
	token_endpoint: "https://auth.copal.uk/oauth2/token",
	revocation_endpoint: "https://auth.copal.uk/oauth2/revoke",
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers discovery and records every revocation; `revoke` decides its answer. */
function server(revoke: () => Promise<Response> = () => Promise.resolve(new Response(null))) {
	const revoked: { token: string | null; client: string | null }[] = [];
	const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/oauth2/revoke")) {
			const form = new URLSearchParams(init?.body as string);
			revoked.push({ token: form.get("token"), client: form.get("client_id") });
			return revoke();
		}
		if (url.includes(".well-known/oauth-protected-resource")) {
			return json({
				resource: "https://api.copal.uk/mcp",
				authorization_servers: ["https://auth.copal.uk"],
			});
		}
		return json(DISCOVERY);
	});
	return { f: f as unknown as typeof fetch, calls: f, revoked };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("⛔ revokeExposed (NV33)", () => {
	it("revokes each sign-in found in the folder with its own client, then forgets it", async () => {
		const { credentials } = memCredentials();
		credentials.addPendingRevoke({ refresh_token: "RT-1", clientId: "cid-1" });
		credentials.addPendingRevoke({ refresh_token: "RT-2", clientId: "cid-2" });
		const s = server();

		expect(await revokeExposed(credentials, s.f)).toEqual({ revoked: 2, left: 0 });
		expect(s.revoked).toEqual([
			{ token: "RT-1", client: "cid-1" },
			{ token: "RT-2", client: "cid-2" },
		]);
		expect(credentials.pendingRevokes()).toEqual([]);
	});

	it("keeps one the server did not take back, to try again at the next start", async () => {
		const { credentials } = memCredentials();
		credentials.addPendingRevoke({ refresh_token: "RT-1", clientId: "cid" });
		const s = server(() => Promise.reject(new Error("offline")));

		expect(await revokeExposed(credentials, s.f)).toEqual({ revoked: 0, left: 1 });
		expect(credentials.pendingRevokes()).toEqual([{ refresh_token: "RT-1", clientId: "cid" }]);

		// Next start, online again.
		expect(await revokeExposed(credentials, server().f)).toEqual({ revoked: 1, left: 0 });
	});

	it("forgets a token the server no longer holds, rather than retrying it at every start", async () => {
		// Production answers a refresh token another device has already rotated away with 400 `token not
		// found` (measured 2026-10-30). It can never be used again, so there is nothing left to do.
		const { credentials } = memCredentials();
		credentials.addPendingRevoke({ refresh_token: "RT-ROTATED", clientId: "cid" });
		const s = server(() =>
			Promise.resolve(
				json({ error: "invalid_request", error_description: "token not found" }, 400),
			),
		);

		expect(await revokeExposed(credentials, s.f)).toEqual({ revoked: 1, left: 0 });
		expect(credentials.pendingRevokes()).toEqual([]);
	});

	it("gives up for this start after 4 s rather than holding sync back", async () => {
		vi.useFakeTimers();
		const { credentials } = memCredentials();
		credentials.addPendingRevoke({ refresh_token: "RT-1", clientId: "cid" });
		const hanging = server(() => new Promise<Response>(() => {}));

		const result = revokeExposed(credentials, hanging.f);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(await result).toEqual({ revoked: 0, left: 1 });
	});

	it("touches the network not at all when there is nothing to revoke", async () => {
		const s = server();
		expect(await revokeExposed(memCredentials().credentials, s.f)).toEqual({ revoked: 0, left: 0 });
		expect(s.calls).not.toHaveBeenCalled();
	});
});
