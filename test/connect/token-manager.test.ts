import { describe, expect, it, vi } from "vitest";
import { TokenManager, type ReauthReason } from "../../src/connect/token-manager";
import { TokenStore } from "../../src/connect/store";
import type { PersistedData } from "../../src/connect/store";
import type { Tokens } from "../../src/types";

function memStore(initial: PersistedData = {}): TokenStore {
	let data: PersistedData = { ...initial };
	return new TokenStore(
		() => Promise.resolve(data),
		(next) => {
			data = next;
			return Promise.resolve();
		},
	);
}

/**
 * Production-shaped, and it has to be: the gateway is the RESOURCE and `auth.copal.uk` is the
 * authorization server, so the issuer and every endpoint share that origin. This fixture used to name
 * `api.copal.uk` as the server while claiming `auth.copal.uk` as the issuer, which is precisely the
 * mismatch RFC 8414 §3.3 exists to refuse.
 */
const DISCOVERY = {
	issuer: "https://auth.copal.uk",
	registration_endpoint: "https://auth.copal.uk/oauth2/register",
	authorization_endpoint: "https://auth.copal.uk/oauth2/authorize",
	token_endpoint: "https://auth.copal.uk/oauth2/token",
	revocation_endpoint: "https://auth.copal.uk/oauth2/revoke",
};

/** `memStore`, but the raw record stays readable so a test can prove what was NOT written. */
function peekableStore(initial: PersistedData = {}): {
	store: TokenStore;
	peek: () => PersistedData;
} {
	let data: PersistedData = { ...initial };
	return {
		store: new TokenStore(
			() => Promise.resolve(data),
			(next) => {
				data = next;
				return Promise.resolve();
			},
		),
		peek: () => data,
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * A fetch that answers discovery from cache and routes token posts to `onToken`.
 *
 * `onRevoke` is optional so every existing caller is unchanged; revocation bodies are captured so a
 * test can assert WHICH token was revoked, which is the whole question in the sign-out race.
 */
function fetchWith(
	onToken: () => Promise<Response>,
	onRevoke: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 200 })),
	discovery: unknown = DISCOVERY,
	onGrantRevoke: () => Promise<Response> = () =>
		Promise.resolve(new Response(null, { status: 200 })),
): {
	f: ReturnType<typeof vi.fn>;
	tokenCalls: () => number;
	revokedTokens: () => string[];
	grantRevokes: () => string[];
} {
	let tokenCalls = 0;
	const revokedTokens: string[] = [];
	const grantRevokes: string[] = [];
	const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/account/revoke-grant-by-token")) {
			grantRevokes.push(
				(JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string }).refresh_token ?? "",
			);
			return onGrantRevoke();
		}
		if (url.includes("/oauth2/revoke")) {
			revokedTokens.push(new URLSearchParams(init?.body as string).get("token") ?? "");
			return onRevoke();
		}
		if (url.includes("/oauth2/token")) {
			tokenCalls += 1;
			return onToken();
		}
		// Both discovery candidates (RFC 9728 with-path, then the bare fallback).
		if (url.includes(".well-known/oauth-protected-resource")) {
			return json({
				resource: "https://api.copal.uk/mcp",
				authorization_servers: ["https://auth.copal.uk"],
			});
		}
		return json(discovery);
	});
	return {
		f: f as unknown as ReturnType<typeof vi.fn>,
		tokenCalls: () => tokenCalls,
		revokedTokens: () => revokedTokens,
		grantRevokes: () => grantRevokes,
	};
}

/**
 * Drain microtasks until `cond` holds.
 *
 * ⚠️ A single `await Promise.resolve()` is NOT enough to get a refresh onto the network: `getValid`
 * awaits the store first, so the mutex is not even armed yet. Driving the sign-out race against that
 * tests the wrong interleaving and passes for the wrong reason.
 */
async function until(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100 && !cond(); i += 1) await Promise.resolve();
	if (!cond()) throw new Error(`never happened: ${what}`);
}

const EXPIRED: Tokens = {
	access_token: "old-at",
	refresh_token: "old-rt",
	expires_at: 1_000,
};

function make(
	store: TokenStore,
	f: unknown,
	onReauth: (r: ReauthReason) => void = () => {},
	now = () => 10_000_000,
) {
	return new TokenManager({
		f: f as typeof fetch,
		store,
		onReauthRequired: onReauth,
		now,
	});
}

describe("TokenManager single-flight", () => {
	/**
	 * ⛔ The one that matters. Refresh tokens rotate and a replay deletes the whole family, so two
	 * concurrent refreshes are an instant unrecoverable logout — worse than the bug this fixes.
	 * The deferred promise makes the calls genuinely overlap rather than interleaving by luck.
	 */
	it("collapses N concurrent getValid() into exactly ONE token request", async () => {
		let release!: (r: Response) => void;
		const gate = new Promise<Response>((res) => {
			release = res;
		});
		const { f, tokenCalls } = fetchWith(() => gate);
		const tm = make(memStore({ clientId: "cid", tokens: EXPIRED }), f);

		const all = Promise.all([tm.getValid(), tm.getValid(), tm.getValid(), tm.getValid()]);
		await Promise.resolve();
		release(json({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }));

		expect(await all).toEqual(["new-at", "new-at", "new-at", "new-at"]);
		expect(tokenCalls(), "more than one refresh fired — this replays a rotated token").toBe(1);
	});

	it("collapses a burst of 401s into ONE token request", async () => {
		let release!: (r: Response) => void;
		const gate = new Promise<Response>((res) => {
			release = res;
		});
		const { f, tokenCalls } = fetchWith(() => gate);
		const tm = make(memStore({ clientId: "cid", tokens: EXPIRED }), f);

		const all = Promise.all([
			tm.refreshAfterUnauthorized("old-at"),
			tm.refreshAfterUnauthorized("old-at"),
			tm.refreshAfterUnauthorized("old-at"),
		]);
		await Promise.resolve();
		release(json({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }));

		expect(await all).toEqual(["new-at", "new-at", "new-at"]);
		expect(tokenCalls()).toBe(1);
	});

	/** The compare-and-swap: a caller holding a token someone already replaced does no work. */
	it("makes ZERO network calls when the stored token already moved on", async () => {
		const { f, tokenCalls } = fetchWith(() => Promise.resolve(json({})));
		const store = memStore({
			clientId: "cid",
			tokens: { access_token: "already-new", refresh_token: "rt", expires_at: 9e15 },
		});
		const tm = make(store, f);

		expect(await tm.refreshAfterUnauthorized("stale-at")).toBe("already-new");
		expect(tokenCalls()).toBe(0);
	});

	it("does not refresh a token that is still comfortably valid", async () => {
		const { f, tokenCalls } = fetchWith(() => Promise.resolve(json({})));
		const store = memStore({
			clientId: "cid",
			tokens: { access_token: "good", refresh_token: "rt", expires_at: 9e15 },
		});
		expect(await make(store, f).getValid()).toBe("good");
		expect(tokenCalls()).toBe(0);
	});
});

describe("TokenManager failure classification", () => {
	it("treats invalid_grant as terminal: announces re-auth exactly once", async () => {
		const seen: ReauthReason[] = [];
		const { f } = fetchWith(() => Promise.resolve(json({ error: "invalid_grant" }, 400)));
		const tm = make(memStore({ clientId: "cid", tokens: EXPIRED }), f, (r) => seen.push(r));

		expect(await tm.refreshAfterUnauthorized("old-at")).toBeNull();
		expect(await tm.refreshAfterUnauthorized("old-at")).toBeNull();
		expect(seen, "a burst of 401s must not become a burst of notices").toEqual(["expired"]);
	});

	/**
	 * ⛔ The falsifier for the whole classification, and the one that protects against a WORSE bug
	 * than the original: signing a user out because their wifi dropped would lose unsynced work.
	 */
	it("treats a 500 as TRANSIENT: no re-auth, and the tokens survive", async () => {
		const seen: ReauthReason[] = [];
		const { f } = fetchWith(() => Promise.resolve(json({ error: "server_error" }, 500)));
		const store = memStore({ clientId: "cid", tokens: EXPIRED });
		const tm = make(store, f, (r) => seen.push(r));

		expect(await tm.refreshAfterUnauthorized("old-at")).toBeNull();
		expect(seen, "a server hiccup signed the user out").toEqual([]);
		expect((await store.getTokens())?.refresh_token, "tokens were discarded on a 5xx").toBe(
			"old-rt",
		);
	});

	it("treats a transport failure as TRANSIENT and keeps the tokens", async () => {
		const seen: ReauthReason[] = [];
		const f = vi.fn(async (input: string | URL | Request) => {
			if (String(input).includes("/oauth2/token")) throw new TypeError("network down");
			if (String(input).includes(".well-known/oauth-protected-resource")) {
				return json({
					resource: "https://api.copal.uk/mcp",
					authorization_servers: ["https://auth.copal.uk"],
				});
			}
			return json(DISCOVERY);
		});
		const store = memStore({ clientId: "cid", tokens: EXPIRED });
		const tm = make(store, f, (r) => seen.push(r));

		expect(await tm.refreshAfterUnauthorized("old-at")).toBeNull();
		expect(seen).toEqual([]);
		expect((await store.getTokens())?.access_token).toBe("old-at");
	});

	it("announces re-auth when there is no refresh token at all (the pre-fix install)", async () => {
		const seen: ReauthReason[] = [];
		const { f, tokenCalls } = fetchWith(() => Promise.resolve(json({})));
		const store = memStore({
			clientId: "cid",
			tokens: { access_token: "at", expires_at: 1_000 },
		});
		const tm = make(store, f, (r) => seen.push(r));

		expect(await tm.getValid(), "the stale token is still handed back to try").toBe("at");
		expect(seen).toEqual(["no-refresh-token"]);
		expect(tokenCalls()).toBe(0);
	});
});

describe("TokenManager token merge", () => {
	it("keeps the existing refresh token when the response omits one", async () => {
		const { f } = fetchWith(() =>
			Promise.resolve(json({ access_token: "new-at", expires_in: 3600 })),
		);
		const store = memStore({ clientId: "cid", tokens: EXPIRED });
		await make(store, f).getValid();
		expect((await store.getTokens())?.refresh_token).toBe("old-rt");
	});

	/** Without carrying it forward, a response with no `expires_in` disables refresh forever. */
	it("carries expires_at forward when the response omits expires_in", async () => {
		const { f } = fetchWith(() =>
			Promise.resolve(json({ access_token: "new-at", refresh_token: "new-rt" })),
		);
		const store = memStore({ clientId: "cid", tokens: EXPIRED });
		await make(store, f).getValid();
		expect((await store.getTokens())?.expires_at).toBe(1_000);
	});

	it("persists the new token before handing it out", async () => {
		const { f } = fetchWith(() =>
			Promise.resolve(json({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 })),
		);
		const store = memStore({ clientId: "cid", tokens: EXPIRED });
		const handed = await make(store, f).getValid();
		expect((await store.getTokens())?.access_token).toBe(handed);
		expect((await store.getTokens())?.refresh_token).toBe("new-rt");
	});
});

/**
 * ⛔ **The sign-out race (C14), driven rather than asserted.**
 *
 * Every case here holds the token POST open on a gate so sign-out lands in the exact window that
 * matters: after the server has rotated the refresh token, before the plugin has written it down.
 * A happy-path test cannot see any of this.
 */
describe("sign-out", () => {
	it("does not re-persist a rotated token when sign-out lands mid-refresh", async () => {
		let release!: (r: Response) => void;
		const gate = new Promise<Response>((res) => {
			release = res;
		});
		const { f, revokedTokens, tokenCalls } = fetchWith(() => gate);
		const { store, peek } = peekableStore({ clientId: "cid", tokens: EXPIRED });
		const tm = make(store, f);

		// A refresh is in flight and suspended on the network.
		const inFlight = tm.getValid().catch(() => "threw");
		await until(() => tokenCalls() === 1, "the refresh reached the token endpoint");

		// The user signs out while it is suspended.
		const outcome = tm.revokeAndAbandon();
		// Only now does the server's rotation land.
		release(json({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }));

		expect(await inFlight).toBe("threw");
		expect(await outcome).toBe("revoked");

		// THE ASSERTION. `data.json` must still hold the pre-sign-out record: had the rotated token
		// been written, a copy of this vault could renew from it for another 14 days.
		expect(peek().tokens?.refresh_token).toBe("old-rt");
		expect(peek().tokens?.access_token).toBe("old-at");
		// And the orphan is what got revoked: the stored token was already dead, killed by the very
		// rotation this refresh completed, so revoking it would have reported success over a no-op.
		expect(revokedTokens()).toEqual(["new-rt"]);
	});

	it("revokes the stored refresh token when nothing is in flight", async () => {
		const { f, revokedTokens, tokenCalls } = fetchWith(() =>
			Promise.reject(new Error("no refresh expected")),
		);
		const tm = make(memStore({ clientId: "cid", tokens: EXPIRED }), f);
		expect(await tm.revokeAndAbandon()).toBe("revoked");
		expect(revokedTokens()).toEqual(["old-rt"]);
		expect(tokenCalls()).toBe(0);
	});

	it("reports failure without throwing when the server refuses the revocation", async () => {
		const { f } = fetchWith(
			() => Promise.reject(new Error("no refresh expected")),
			() => Promise.resolve(new Response(null, { status: 503 })),
		);
		const tm = make(memStore({ clientId: "cid", tokens: EXPIRED }), f);
		// Must RESOLVE. Sign-out deletes the local tokens straight after this and cannot be allowed to
		// die on the way there.
		expect(await tm.revokeAndAbandon()).toBe("failed");
	});

	it("reports failure without throwing when the network is dead", async () => {
		const { f } = fetchWith(
			() => Promise.reject(new Error("no refresh expected")),
			() => Promise.reject(new TypeError("Failed to fetch")),
		);
		const tm = make(memStore({ clientId: "cid", tokens: EXPIRED }), f);
		expect(await tm.revokeAndAbandon()).toBe("failed");
	});

	it("has nothing to revoke on a pre-offline_access install, and calls nothing", async () => {
		const { f } = fetchWith(() => Promise.reject(new Error("no refresh expected")));
		const tm = make(memStore({ clientId: "cid", tokens: { access_token: "at" } }), f);
		expect(await tm.revokeAndAbandon()).toBe("nothing-to-revoke");
		expect(f).not.toHaveBeenCalled();
	});

	it("reports failure when the server publishes no revocation endpoint", async () => {
		const { f } = fetchWith(
			() => Promise.reject(new Error("no refresh expected")),
			() => Promise.resolve(new Response(null, { status: 200 })),
			{ ...DISCOVERY, revocation_endpoint: undefined },
		);
		const tm = make(memStore({ clientId: "cid", tokens: EXPIRED }), f);
		expect(await tm.revokeAndAbandon()).toBe("failed");
	});

	it("abandon() closes the same race with no network call at all", async () => {
		let release!: (r: Response) => void;
		const gate = new Promise<Response>((res) => {
			release = res;
		});
		const { f, revokedTokens, tokenCalls } = fetchWith(() => gate);
		const { store, peek } = peekableStore({ clientId: "cid", tokens: EXPIRED });
		const tm = make(store, f);

		const inFlight = tm.getValid().catch(() => "threw");
		await until(() => tokenCalls() === 1, "the refresh reached the token endpoint");
		const abandoned = tm.abandon();
		release(json({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }));
		expect(await inFlight).toBe("threw");
		await abandoned;

		expect(peek().tokens?.refresh_token).toBe("old-rt");
		// The credential was already dead on this path; revoking it would be a pointless round trip.
		expect(revokedTokens()).toEqual([]);
	});

	/**
	 * ⛔ Disconnect means the WHOLE grant. RFC 7009 kills the token family but leaves the consent, so the
	 * server keeps reporting the grant active and the account page keeps listing the plugin. `revoke.ts`
	 * in copal-auth calls consent-plus-both-families the honest definition, and this is the client half.
	 */
	it("takes the whole grant when asked, instead of just the token", async () => {
		const { f, grantRevokes, revokedTokens } = fetchWith(() =>
			Promise.reject(new Error("no refresh expected")),
		);
		const tm = make(memStore({ clientId: "cid", tokens: EXPIRED }), f);

		expect(await tm.revokeAndAbandon("grant")).toBe("revoked");

		expect(grantRevokes()).toEqual(["old-rt"]);
		expect(revokedTokens()).toEqual([]); // no need for the token-scoped call as well
	});

	/*
	 * A server that does not serve the route yet must still end up with a dead credential — otherwise
	 * shipping the plugin before the auth deploy would silently stop revoking anything at all.
	 */
	it("falls back to the token revoke when the grant route is not there", async () => {
		const { f, grantRevokes, revokedTokens } = fetchWith(
			() => Promise.reject(new Error("no refresh expected")),
			undefined,
			DISCOVERY,
			() => Promise.resolve(new Response(null, { status: 404 })),
		);
		const tm = make(memStore({ clientId: "cid", tokens: EXPIRED }), f);

		expect(await tm.revokeAndAbandon("grant")).toBe("revoked");

		expect(grantRevokes()).toEqual(["old-rt"]); // tried
		expect(revokedTokens()).toEqual(["old-rt"]); // and fell back, so the credential still dies
	});
});
