import { asTrustedUrl, type TrustedUrl } from "../sync/safe-url";
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

/**
 * The authorization server's RFC 8414 metadata, with every URL already checked.
 *
 * The fields are `TrustedUrl`, not `string`, and `asTrustedUrl` is the only way to make one — so a sink
 * added later cannot send a token to a URL nobody validated without failing `tsc`. That matters here
 * more than usual: this type grew two new sinks in a single afternoon, both added by someone who had
 * just finished reading this file.
 */
export interface Discovery {
	/** RFC 8414 identifier of the authorization server, and the origin Copal's own routes live on. */
	issuer: TrustedUrl;
	registration_endpoint: TrustedUrl;
	authorization_endpoint: TrustedUrl;
	token_endpoint: TrustedUrl;
	/** RFC 7009. Optional: a server that publishes none must degrade to a local-only sign-out. */
	revocation_endpoint?: TrustedUrl;
}

/**
 * The one door to the network in this module. Taking a `TrustedUrl` is what makes the branding
 * load-bearing rather than decorative: branding the `Discovery` fields protects today's sinks, and this
 * protects the next one, including a sink that reads some other server-supplied field entirely.
 */
function trustedFetch(f: typeof fetch, url: TrustedUrl, init?: RequestInit): Promise<Response> {
	return f(url, init);
}

/** Read a required string field out of a server-supplied document. */
function required(doc: Record<string, unknown>, field: string): string {
	const value = doc[field];
	if (typeof value !== "string" || value === "") {
		throw new Error(`discovery failed: metadata has no ${field}`);
	}
	return value;
}

/** The MCP resource this plugin authenticates against — the identifier tokens are minted for. */
const MCP_RESOURCE = `${API_BASE}/mcp`;

interface ProtectedResource {
	/** RFC 9728 requires it, and it must name the resource we actually authenticate against. */
	resource?: string;
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
		// `API_BASE` is compiled in, so this hop is trusted by construction — it is the ROOT of the chain,
		// and the only link that does not have to be checked.
		// oxlint-disable-next-line no-await-in-loop
		const res = await trustedFetch(f, asTrustedUrl(url));
		if (!res.ok) continue;
		const doc = (await res.json()) as ProtectedResource;
		// A document for some other resource is not ours to follow: it would name that resource's
		// authorization server, and we would hand it credentials minted for `MCP_RESOURCE`.
		if (doc.resource !== MCP_RESOURCE) {
			throw new Error(
				`discovery failed: metadata is for resource ${String(doc.resource)}, not ${MCP_RESOURCE}`,
			);
		}
		return doc;
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
	const named = servers?.[0];
	if (named === undefined) {
		throw new Error("discovery failed: the resource names no authorization server");
	}
	// ⛔ Validated BEFORE the hop, never after. A check that runs on the response has already let the
	// request reach a host of the document's choosing, and `requestUrl` is not subject to CORS.
	const base = asTrustedUrl(named);
	// `new URL(path, base)`, not concatenation: a path, query or fragment on the named server would
	// otherwise be spliced into the well-known URL.
	const metadataUrl = asTrustedUrl(
		new URL("/.well-known/oauth-authorization-server", base).toString(),
	);
	const res = await trustedFetch(f, metadataUrl);
	if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
	return validateDiscovery((await res.json()) as Record<string, unknown>, base);
}

/**
 * Turn an unvalidated metadata document into a `Discovery`, or refuse it.
 *
 * Two rules, and the second is what makes the rest safe by construction. Each URL must pass the
 * trusted-URL policy; and, per RFC 8414 §3.3, the document's own `issuer` must be the origin it was
 * served from, with every endpoint sharing that origin. Without the second rule a host that can serve
 * one document could point a single endpoint — say the token endpoint — somewhere else, and only that
 * one sink would leak.
 */
function validateDiscovery(doc: Record<string, unknown>, base: TrustedUrl): Discovery {
	const issuer = asTrustedUrl(required(doc, "issuer"));
	const origin = new URL(issuer).origin;
	if (origin !== new URL(base).origin) {
		throw new Error(
			`discovery failed: issuer ${issuer} was served by ${new URL(base).origin}`, // RFC 8414 §3.3
		);
	}
	const endpoint = (field: string): TrustedUrl => {
		const url = asTrustedUrl(required(doc, field));
		if (new URL(url).origin !== origin) {
			throw new Error(`discovery failed: ${field} is on a different origin from the issuer`);
		}
		return url;
	};
	return {
		issuer,
		registration_endpoint: endpoint("registration_endpoint"),
		authorization_endpoint: endpoint("authorization_endpoint"),
		token_endpoint: endpoint("token_endpoint"),
		// Optional by RFC 7009 — absent means sign-out degrades to local-only, present means checked.
		...(doc.revocation_endpoint === undefined
			? {}
			: { revocation_endpoint: endpoint("revocation_endpoint") }),
	};
}

export async function registerClient(
	f: typeof fetch,
	registrationEndpoint: TrustedUrl,
): Promise<ClientReg> {
	const res = await trustedFetch(f, registrationEndpoint, {
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
	const body = (await res.json()) as { client_id?: unknown };
	if (typeof body.client_id !== "string" || body.client_id === "") {
		throw new Error("registration returned no usable client_id");
	}
	return { client_id: body.client_id };
}

export function buildAuthorizeUrl(
	endpoint: TrustedUrl,
	clientId: string,
	pkce: PkcePair,
	state: string,
): TrustedUrl {
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
	// Re-checked rather than asserted. This is the one product of this module that is OPENED rather than
	// fetched — `window.open` on desktop, a real `<a href>` on mobile — so it is the sink where a mistake
	// executes code instead of leaking a token.
	return asTrustedUrl(u.toString());
}

/**
 * Turn a token response into `Tokens`, checking TYPES and not merely presence.
 *
 * ⚠️ `expires_in` is the one that bites quietly. A non-numeric value made `Date.now() + x * 1000`
 * evaluate to `NaN`, and every expiry comparison against `NaN` is false — so the token would never be
 * refreshed and would simply start 401ing an hour later with nothing anywhere saying why. Dropping the
 * field instead means the token is treated as having no known expiry, which the refresh path already
 * handles.
 */
function toTokens(raw: unknown): Tokens {
	const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	if (typeof r.access_token !== "string" || r.access_token === "") {
		throw new Error("token response missing access_token");
	}
	if (r.refresh_token !== undefined && typeof r.refresh_token !== "string") {
		throw new Error("token response has a non-string refresh_token");
	}
	const expiresIn =
		typeof r.expires_in === "number" && Number.isFinite(r.expires_in) ? r.expires_in : undefined;
	return {
		access_token: r.access_token,
		...(r.refresh_token === undefined ? {} : { refresh_token: r.refresh_token }),
		...(typeof r.scope === "string" ? { scope: r.scope } : {}),
		...(expiresIn === undefined ? {} : { expires_at: Date.now() + expiresIn * 1000 }),
	};
}

export async function exchangeCode(
	f: typeof fetch,
	tokenEndpoint: TrustedUrl,
	clientId: string,
	code: string,
	verifier: string,
): Promise<Tokens> {
	const res = await trustedFetch(f, tokenEndpoint, {
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
	tokenEndpoint: TrustedUrl,
	clientId: string,
	refreshToken: string,
): Promise<Tokens> {
	const res = await trustedFetch(f, tokenEndpoint, {
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

/**
 * RFC 7009: tell the authorization server to forget this refresh token.
 *
 * ⛔ **THIS IS WHAT MAKES SIGN-OUT MEAN SOMETHING.** `data.json` lives inside the vault, so every
 * copy of the vault (iCloud, Obsidian Sync, git) carries the refresh token with it. Deleting the
 * local key alone leaves every one of those copies able to mint fresh access tokens for the rest of
 * the token's 14-day sliding life, with no client secret needed. The settings pane's advice to
 * "sign out on devices you no longer use" is only true because of this call.
 *
 * Revoking the REFRESH token, not the access token, is deliberate three times over:
 *  - A JWT access token cannot be revoked at all here. The provider answers `unsupported_token_type`
 *    for one, because it is self-contained and the gateway verifies it offline.
 *  - Rotation means the token we hold is the only live one in its family, so killing it leaves the
 *    family with no live member.
 *  - The next refresh attempt with a revoked token trips the server's `invalidateRefreshFamily`,
 *    which deletes every access and refresh token for the (client, user) pair.
 *
 * ⚠️ `clientId` MUST be the registration the token was issued to. The endpoint answers **200 with no
 * effect** when the client id does not match the token's (RFC 7009 says an unknown token is not an
 * error), so a wrong or invented id is a silent no-op that looks exactly like success.
 *
 * ⚠️ Form-encoded, not JSON: the provider declares `allowedMediaTypes:
 * ["application/x-www-form-urlencoded"]` and rejects a JSON body outright.
 *
 * Throws on a non-ok response so the caller can report honestly. The caller is also the one that
 * decides to swallow: a failed revoke must never block the local sign-out.
 */
export async function revoke(
	f: typeof fetch,
	revocationEndpoint: TrustedUrl,
	clientId: string,
	refreshToken: string,
): Promise<void> {
	const res = await trustedFetch(f, revocationEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			token: refreshToken,
			// Explicit, though the server would fall through to it anyway. Without the hint it first
			// tries to read the token as an access token, which costs a JWKS verify and turns a clean
			// revoke into a confusing `unsupported_token_type` in the server's logs.
			token_type_hint: "refresh_token",
			client_id: clientId,
		}).toString(),
	});
	if (!res.ok) throw new Error(`token revocation failed: ${res.status}`);
}

/**
 * Take the whole grant back, not just the token: Copal's own endpoint, which deletes the consent AND
 * both token families.
 *
 * ⛔ **WHY THIS EXISTS ALONGSIDE `revoke`.** RFC 7009 kills the token family, which is what stops a
 * copied `data.json` renewing itself — but the authorization server keeps the consent row, so its grant
 * check keeps answering "active" (an access token already issued survives its hour) and the account page
 * still lists this plugin under Connected agents. Disconnect says it detaches the folder entirely, so it
 * has to mean the whole grant. Sign-out deliberately does NOT call this: dropping consent would put a
 * consent screen in front of every ordinary pause-and-resume.
 *
 * Possession of the refresh token is the authentication — the same proof RFC 7009 accepts, and the same
 * credential that can already mint access tokens, so it grants nothing new.
 *
 * Throws on a non-ok response. The caller falls back to `revoke`, so a server that does not serve this
 * route yet still gets the credential killed.
 */
export async function revokeGrant(
	f: typeof fetch,
	issuer: TrustedUrl,
	refreshToken: string,
): Promise<void> {
	// The only consumer that appends its own path to a discovered value, so it is the one whose SHAPE
	// differs — a bare origin rather than an endpoint. `new URL(path, issuer)` resolves against the
	// origin and drops any path, query or fragment the issuer carried.
	const url = asTrustedUrl(new URL("/account/revoke-grant-by-token", issuer).toString());
	const res = await trustedFetch(f, url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ refresh_token: refreshToken }),
	});
	if (!res.ok) throw new Error(`grant revocation failed: ${res.status}`);
}
