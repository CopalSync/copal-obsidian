import type { ClientReg, PkcePair, Tokens } from "../types";

export const API_BASE = "https://api.copal.uk";
/**
 * Where the authorization server sends the code — an https URL, NOT `obsidian://copal-connect`.
 *
 * A private-use scheme can be claimed by any installed app, so the OS cannot say who owns
 * `obsidian://` and a malicious app could intercept the code. RFC 8252 §7.1 therefore wants a
 * reverse-domain scheme the author controls, and `@better-auth/oauth-provider` 1.7 enforces that,
 * refusing to register `obsidian://…` at all. Obsidian only routes its own scheme, so the
 * reverse-domain form is unavailable — leaving the option RFC 8252 §7.2 prefers anyway: redirect
 * to a domain we control and let it forward inward.
 *
 * `copal.uk/plugin/connect` forwards the code straight to `obsidian://copal-connect`, so the
 * protocol handler below is unchanged. PKCE still protects the exchange: the verifier never leaves
 * this plugin, so a code seen in the browser is not redeemable by anyone else.
 */
export const REDIRECT_URI = "https://copal.uk/plugin/connect";
/**
 * ⛔ **`offline_access` IS WHAT BUYS A REFRESH TOKEN. REMOVING IT BREAKS EVERY INSTALL IN AN HOUR.**
 *
 * This read `"vault.read vault.write"` until 2026-09-12, and the consequence was total: Better
 * Auth issues a refresh token only when the granted scopes include `offline_access`
 * (`isRefreshToken`, `@better-auth/oauth-provider/dist/index.mjs`). Without it the plugin holds a
 * ONE-HOUR access token and nothing else, `getValidToken`'s refresh branch is unreachable because
 * `tokens.refresh_token` is never set, and at T+1h every call 401s — both WebSockets dropping into
 * a silent forever-reconnect that reads as "offline" and is indistinguishable from a dead network.
 * 6550 such 401s in one week, and the only cure a user could find was signing out and back in.
 *
 * ⚠️ Changing this string invalidates a stored client registration. `/oauth2/authorize` validates
 * the requested scope against `client.scopes` as captured at registration, so a client registered
 * with one scope can never be authorized with another — which is why `ConnectFlow.start` discards
 * the registration when this value changes. Do not change it without reading that comment.
 *
 * Gated by `copal-auth/test/integration/plugin-grant.test.ts`, which drives this exact constant.
 */
export const SCOPE = "vault.read vault.write offline_access";

interface Discovery {
	registration_endpoint: string;
	authorization_endpoint: string;
	token_endpoint: string;
}

/** The MCP resource this plugin authenticates against — the identifier tokens are minted for. */
const MCP_RESOURCE = `${API_BASE}/mcp`;

interface ProtectedResource {
	authorization_servers?: string[];
}

/**
 * Fetch the RFC 9728 protected-resource document for `MCP_RESOURCE`.
 *
 * Two candidates, in order. RFC 9728 builds the metadata URL by inserting the well-known segment
 * **between host and path**, so a resource with a path (`/mcp`) publishes at
 * `/.well-known/oauth-protected-resource/mcp`. Older gateways served only the bare path, so that
 * is the fallback — which keeps connect working either side of the deploy that moves it.
 */
async function protectedResource(f: typeof fetch): Promise<ProtectedResource> {
	const path = new URL(MCP_RESOURCE).pathname.replace(/\/+$/, "");
	for (const url of [
		`${API_BASE}/.well-known/oauth-protected-resource${path}`,
		`${API_BASE}/.well-known/oauth-protected-resource`,
	]) {
		const res = await f(url);
		if (res.ok) return (await res.json()) as ProtectedResource;
	}
	throw new Error("discovery failed: the server published no protected-resource metadata");
}

/**
 * Find the authorization server, then read its metadata.
 *
 * The gateway is a RESOURCE server: it does not issue tokens and does not serve
 * `/.well-known/oauth-authorization-server` — asking it for one 404s. Which host IS the
 * authorization server is something only the protected-resource document can say, so this follows
 * it rather than assuming. Assuming is exactly what broke connect when the two moved apart.
 */
export async function discover(f: typeof fetch): Promise<Discovery> {
	const { authorization_servers: servers } = await protectedResource(f);
	const issuer = servers?.[0];
	if (issuer === undefined) {
		throw new Error("discovery failed: the resource names no authorization server");
	}
	const res = await f(`${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`);
	if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
	return (await res.json()) as Discovery;
}

export async function registerClient(
	f: typeof fetch,
	registrationEndpoint: string,
): Promise<ClientReg> {
	const res = await f(registrationEndpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "Copal for Obsidian",
			redirect_uris: [REDIRECT_URI],
			// Truthful, and MCP 2026-07-28 requires clients to declare it. `web` would also be accepted
			// now that REDIRECT_URI is https, but this is a native app and the distinction is what the
			// server uses to decide which redirect shapes are legal for it.
			application_type: "native",
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			scope: SCOPE,
		}),
	});
	if (!res.ok) throw new Error(`client registration failed: ${res.status}`);
	const body = (await res.json()) as { client_id?: string };
	if (!body.client_id) throw new Error("registration returned no client_id");
	return { client_id: body.client_id };
}

export function buildAuthorizeUrl(
	endpoint: string,
	clientId: string,
	pkce: PkcePair,
	state: string,
): string {
	const u = new URL(endpoint);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("client_id", clientId);
	u.searchParams.set("redirect_uri", REDIRECT_URI);
	u.searchParams.set("scope", SCOPE);
	u.searchParams.set("code_challenge", pkce.challenge);
	u.searchParams.set("code_challenge_method", "S256");
	u.searchParams.set("state", state);
	/*
	 * ⛔ **RFC 8707. WITHOUT THIS THE TOKEN IS OPAQUE AND THE GATEWAY 401s EVERYTHING.**
	 *
	 * `copal-auth/src/auth.config.ts` says it plainly: the resource is "what makes the token a JWT
	 * AT ALL — this library issues an opaque access token when there is no audience to assign, and
	 * an opaque token cannot be verified offline, surfacing at the gateway as an ordinary bad-token
	 * 401." The gateway pins `aud` to `OAUTH_AUDIENCE`, which is this exact string.
	 *
	 * So the symptom is maximally misleading: sign-in succeeds, the code exchanges, tokens are
	 * stored, and then every call fails as if the credential were wrong. It is not wrong, it is
	 * unverifiable. MCP 2026-07-28 requires this parameter too, so it is not an optimisation.
	 */
	u.searchParams.set("resource", MCP_RESOURCE);
	return u.toString();
}

function toTokens(raw: {
	access_token?: string;
	refresh_token?: string;
	scope?: string;
	expires_in?: number;
}): Tokens {
	if (!raw.access_token) throw new Error("token response missing access_token");
	return {
		access_token: raw.access_token,
		...(raw.refresh_token === undefined ? {} : { refresh_token: raw.refresh_token }),
		...(raw.scope === undefined ? {} : { scope: raw.scope }),
		...(raw.expires_in === undefined ? {} : { expires_at: Date.now() + raw.expires_in * 1000 }),
	};
}

export async function exchangeCode(
	f: typeof fetch,
	tokenEndpoint: string,
	clientId: string,
	code: string,
	verifier: string,
): Promise<Tokens> {
	const res = await f(tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: clientId,
			code_verifier: verifier,
			// Sent at BOTH legs, as RFC 8707 §2 requires. The authorize leg records what was consented
			// to; this one selects which of those the token is minted for. Omitting it here lands back
			// on "no audience to assign" and an opaque token, with the authorize leg looking correct.
			resource: MCP_RESOURCE,
		}).toString(),
	});
	if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
	return toTokens(await res.json());
}

/**
 * A failed refresh, carrying whether the credential is DEAD or merely unreachable.
 *
 * ⛔ The distinction is the whole point, and getting it wrong is worse than the bug it guards.
 * Signing someone out because their train went into a tunnel would lose unsynced work and make the
 * product look broken. So `terminal` is true ONLY for the OAuth errors that mean the grant itself
 * is gone; a 500, a timeout, a captive portal and a DNS failure are all transient, and the caller
 * keeps the tokens and retries later.
 */
export class TokenRefreshError extends Error {
	constructor(
		readonly status: number | undefined,
		readonly oauthError: string | undefined,
		/** The grant is gone and no retry will help — the user must sign in again. */
		readonly terminal: boolean,
	) {
		super(`token refresh failed: ${status ?? "network"}${oauthError ? ` (${oauthError})` : ""}`);
		this.name = "TokenRefreshError";
	}

	/**
	 * Classify a non-ok token response. RFC 6749 §5.2 error codes; anything else (5xx, an HTML error
	 * page from a proxy, a body that is not JSON) is treated as transient, because the one thing we
	 * must not do is discard a live credential on a server hiccup.
	 */
	static async from(res: Response): Promise<TokenRefreshError> {
		let oauthError: string | undefined;
		try {
			const body = (await res.json()) as { error?: unknown };
			if (typeof body.error === "string") oauthError = body.error;
		} catch {
			// A non-JSON body tells us nothing; fall through and let the status decide.
		}
		const dead = new Set([
			"invalid_grant",
			"invalid_client",
			"unauthorized_client",
			"invalid_scope",
		]);
		const terminal =
			res.status >= 400 && res.status < 500 && oauthError !== undefined && dead.has(oauthError);
		return new TokenRefreshError(res.status, oauthError, terminal);
	}
}

export async function refresh(
	f: typeof fetch,
	tokenEndpoint: string,
	clientId: string,
	refreshToken: string,
): Promise<Tokens> {
	const res = await f(tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientId,
			/*
			 * ⛔ **`scope` IS DELIBERATELY ABSENT. DO NOT "FIX" THIS BY ADDING IT.**
			 *
			 * Omitting it makes the server reuse `refreshToken.scopes` — the full granted set,
			 * `offline_access` included. Sending it is a DOWN-SCOPE request, and a rotated token that
			 * loses `offline_access` stops being refreshable: the next refresh returns no
			 * `refresh_token` at all, the chain silently terminates, and every device logs out
			 * together weeks later when the last token expires. `plugin-grant.test.ts` refreshes
			 * TWICE for exactly this reason — one refresh cannot see it.
			 */
			// The refresh leg needs it too, and forgetting it here is the nastiest version of this bug:
			// connecting works, everything works, and then an hour later the refreshed token comes back
			// opaque and every call 401s with nothing having changed.
			resource: MCP_RESOURCE,
		}).toString(),
	});
	if (!res.ok) throw await TokenRefreshError.from(res);
	return toTokens(await res.json());
}
