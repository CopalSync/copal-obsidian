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

const DISCOVERY = {
	registration_endpoint: "https://api.copal.uk/oauth2/register",
	authorization_endpoint: "https://api.copal.uk/oauth2/authorize",
	token_endpoint: "https://api.copal.uk/oauth2/token",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A fetch that answers discovery from cache and routes token posts to `onToken`. */
function fetchWith(onToken: () => Promise<Response>): {
	f: ReturnType<typeof vi.fn>;
	tokenCalls: () => number;
} {
	let tokenCalls = 0;
	const f = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("/oauth2/token")) {
			tokenCalls += 1;
			return onToken();
		}
		// Both discovery candidates (RFC 9728 with-path, then the bare fallback).
		if (url.includes(".well-known/oauth-protected-resource")) {
			return json({ authorization_servers: ["https://api.copal.uk"] });
		}
		return json(DISCOVERY);
	});
	return { f: f as unknown as ReturnType<typeof vi.fn>, tokenCalls: () => tokenCalls };
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
				return json({ authorization_servers: ["https://api.copal.uk"] });
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
