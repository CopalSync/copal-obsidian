import type { Tokens } from "../types";
import { discover, refresh, revoke, revokeGrant, TokenRefreshError } from "./oauth";
import type { TokenStore } from "./store";

/** Refresh this long before `expires_at`, so a call in flight does not race the expiry. */
const REFRESH_SKEW_MS = 60_000;

/**
 * The whole budget for tearing a credential down at sign-out: settling an in-flight refresh AND the
 * revocation round trip.
 *
 * ⚠️ Bounded because **a sign-out that hangs is worse than one that fails to revoke.** Obsidian's
 * `requestUrl` has no timeout of its own, so a captive portal or a dead socket would otherwise leave
 * the settings pane wedged mid sign-out. The same 4s shape as `serverReachable()` in `main.ts`.
 */
const REVOKE_BUDGET_MS = 4_000;

/** What a sign-out was able to do at the authorization server. Only `failed` is worth telling a
 *  person about: `nothing-to-revoke` is the ordinary pre-`offline_access` install. */
export type RevokeOutcome = "revoked" | "nothing-to-revoke" | "failed";

/**
 * How much to take back. `token` kills the credential and keeps the consent, so signing back in is the
 * ordinary pause-and-resume; `grant` takes the consent too, which is what disconnecting a folder means.
 */
export type RevokeScope = "token" | "grant";

/** Resolve to `onTimeout` rather than hanging past `ms`. Clears the timer, so a caller inside a test
 *  runner does not keep the event loop alive for the full budget after it resolves. */
async function withBudget<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(onTimeout), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export type ReauthReason = "expired" | "revoked" | "no-refresh-token";

export interface TokenManagerDeps {
	f: typeof fetch;
	store: TokenStore;
	/**
	 * The credential is dead and no retry will help. Called AT MOST ONCE per manager. The handler is
	 * expected to stop sync and prompt a sign-in — nothing else stops the reconnect loops.
	 */
	onReauthRequired: (reason: ReauthReason) => void;
	now?: () => number;
}

interface Discovery {
	token_endpoint: string;
	revocation_endpoint?: string;
	issuer?: string;
}

/**
 * The plugin's access token: kept fresh, and refreshed EXACTLY ONCE at a time.
 *
 * ⛔ **THE SINGLE-FLIGHT IS A SECURITY CONTROL, NOT A TIDINESS ONE.**
 *
 * Refresh tokens rotate on every use, and the server invalidates the WHOLE FAMILY when a rotated
 * token is presented again — `invalidateRefreshFamily` deletes every access and refresh token for
 * the (client, user) pair, which is an instant, unrecoverable logout. GHSA-392p-2q2v-4372 against
 * `@better-auth/oauth-provider` names "client-side mutex serialization on refresh calls" as the
 * mitigation in as many words. No OAuth client library does this for you: `oauth4webapi` is
 * deliberately low-level and holds no tokens, and the MCP SDK leaves concurrency to the caller.
 *
 * Concurrency here is not hypothetical. `startBound` fires reconcile and `crdt.open` without
 * awaiting between them, the change-feed socket and every per-note CRDT socket each mint their own
 * ticket, and binary sync runs its own calls — so a token that expires while the vault is idle is
 * noticed by several callers in the same tick.
 *
 * Two guards, because one is not enough:
 *
 *  1. **One in-flight promise.** Every concurrent caller awaits the same refresh.
 *  2. **Compare-and-swap against the store.** A burst of simultaneous 401s would otherwise be
 *     merely SERIALISED by the mutex and still fire N refreshes, N-1 of them replaying a token the
 *     first call already rotated — which is the exact thing that kills the family. Callers hand in
 *     the token they failed with; if the stored one already differs, someone else fixed it and we
 *     return theirs with no network call at all.
 */
export class TokenManager {
	private inFlight: Promise<string> | undefined;
	private discovery: Discovery | undefined;
	private reauthAnnounced = false;
	/** Set by sign-out. One-way: an abandoned manager never persists a token again. */
	private abandoned = false;
	/**
	 * A refresh token the server minted for a rotation this manager then refused to persist, because
	 * sign-out landed mid-flight. Nobody holds it, so it is the one that has to be revoked — the token
	 * still in `data.json` was invalidated by that very rotation.
	 */
	private orphanedRefreshToken: string | undefined;

	constructor(private readonly deps: TokenManagerDeps) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	/**
	 * Discovery, memoised for the life of the plugin.
	 *
	 * ⚠️ Memoised mainly so a discovery OUTAGE is never mistaken for a dead credential. It is also
	 * two fewer round trips per refresh than the code this replaces, which fetched it every time.
	 */
	private async discovered(): Promise<Discovery> {
		this.discovery ??= await discover(this.deps.f);
		return this.discovery;
	}

	/** The access token to send, refreshed first if it is expired or about to be. */
	async getValid(): Promise<string> {
		const tokens = await this.deps.store.getTokens();
		if (!tokens?.access_token) throw new Error("not connected");

		const expiringSoon =
			tokens.expires_at !== undefined && tokens.expires_at < this.now() + REFRESH_SKEW_MS;
		if (!expiringSoon) return tokens.access_token;

		if (!tokens.refresh_token) {
			/*
			 * The pre-`offline_access` state. Hand back the token we have — it may still have seconds
			 * on it, and the 401 path will deal with it properly — but say so once, because the
			 * alternative is the silence this whole change exists to end.
			 */
			this.announceReauth("no-refresh-token");
			return tokens.access_token;
		}
		return this.refreshOnce(tokens.access_token);
	}

	/**
	 * A request came back 401. Refresh and hand back a token to retry with, or `null` if the caller
	 * should surface the 401.
	 *
	 * Reactive as well as proactive because the proactive path cannot be trusted alone: there is
	 * ZERO clock tolerance anywhere in the stack (jose defaults `clockTolerance` to 0), phones sleep
	 * and wake with skewed clocks, and `expires_at` is absent entirely if the server ever omits
	 * `expires_in`.
	 */
	async refreshAfterUnauthorized(usedToken: string): Promise<string | null> {
		const tokens = await this.deps.store.getTokens();
		if (!tokens?.access_token) return null;
		// Someone already refreshed while this request was in flight. No network call.
		if (tokens.access_token !== usedToken) return tokens.access_token;
		if (!tokens.refresh_token) {
			this.announceReauth("no-refresh-token");
			return null;
		}
		try {
			return await this.refreshOnce(usedToken);
		} catch {
			// `refreshOnce` has already classified it and announced a terminal failure. A transient
			// one leaves the tokens intact and the caller sees the original 401.
			return null;
		}
	}

	/** The mutex. Never recursive; the retry in `SyncApi.authed` happens at most once per request. */
	private async refreshOnce(usedToken: string): Promise<string> {
		this.inFlight ??= this.doRefresh(usedToken).finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	private async doRefresh(usedToken: string): Promise<string> {
		const { store } = this.deps;
		const tokens = await store.getTokens();
		// Re-checked INSIDE the mutex: a caller that queued behind another refresh must not then
		// replay the token that one just rotated.
		if (!tokens?.refresh_token) throw new Error("not connected");
		if (tokens.access_token !== usedToken) return tokens.access_token;

		const clientId = await store.getClientId();
		if (!clientId) throw new Error("not connected");

		let fresh: Tokens;
		try {
			const disc = await this.discovered();
			fresh = await refresh(this.deps.f, disc.token_endpoint, clientId, tokens.refresh_token);
		} catch (err) {
			// Discovery failures and transport failures are transient by construction: a thrown
			// non-Response error never reached the authorization server at all.
			if (err instanceof TokenRefreshError && err.terminal) {
				this.announceReauth(err.oauthError === "invalid_grant" ? "expired" : "revoked");
			}
			throw err;
		}

		/*
		 * ⛔ **PERSIST BEFORE RETURNING.** By the time this response arrives the server has already
		 * revoked the token we sent, so the new one is the only credential that exists. Losing it to
		 * a crash between here and the next write is an unrecoverable logout.
		 *
		 * The merge keeps the old refresh token when the response omits one, and carries `expires_at`
		 * forward explicitly rather than relying on spread order — a response without `expires_in`
		 * would otherwise leave no expiry at all and permanently disable the proactive path.
		 */
		const merged: Tokens = {
			...fresh,
			...(fresh.refresh_token === undefined ? { refresh_token: tokens.refresh_token } : {}),
			...(fresh.expires_at === undefined && tokens.expires_at !== undefined
				? { expires_at: tokens.expires_at }
				: {}),
		};

		/*
		 * ⛔ **THE SIGN-OUT RACE (C14). THE WRITE BELOW IS WHAT RESURRECTS A REVOKED CREDENTIAL.**
		 *
		 * Everything above this point happened across an `await` on the network. A sign-out inside that
		 * window has already deleted `tokens` from `data.json`, and persisting here would put a
		 * **freshly rotated** refresh token back — one the server considers live for another 14 days,
		 * written into a file that syncs to iCloud, Obsidian Sync and git. The user watched themselves
		 * sign out and is now signed in.
		 *
		 * So the rotated token is kept only in memory, for `revokeAndAbandon` to kill at the server.
		 * Throwing rather than returning it is deliberate: a caller handed a token here would use it,
		 * and it belongs to a session that no longer exists.
		 */
		if (this.abandoned) {
			this.orphanedRefreshToken = merged.refresh_token;
			throw new Error("refresh abandoned by sign-out");
		}
		await store.setTokens(merged);
		return merged.access_token;
	}

	/**
	 * Stop refreshing, for good, and settle anything already in flight.
	 *
	 * Used where the credential is already dead (a terminal refresh failure), so there is nothing
	 * worth revoking — but the race still has to be closed, or the dying refresh re-persists itself.
	 */
	async abandon(): Promise<void> {
		this.abandoned = true;
		await withBudget(this.settleInFlight(), REVOKE_BUDGET_MS, undefined);
	}

	/**
	 * Sign-out: kill the credential at the authorization server, then stop refreshing.
	 *
	 * ⚠️ **Never throws, and never blocks past `REVOKE_BUDGET_MS`.** The caller deletes the local
	 * tokens immediately afterwards whatever this returns: a sign-out that fails because revocation
	 * failed is a worse bug than the one revocation exists to fix.
	 */
	async revokeAndAbandon(scope: RevokeScope = "token"): Promise<RevokeOutcome> {
		return withBudget(this.doRevoke(scope), REVOKE_BUDGET_MS, "failed");
	}

	/**
	 * Settled, not raced. The in-flight call's outcome decides WHICH token is live at the server: if it
	 * completed a rotation, the token in `data.json` is already dead and the live one is the orphan it
	 * handed back. Revoking before knowing that revokes the wrong token and reports success.
	 */
	private async settleInFlight(): Promise<undefined> {
		await this.inFlight?.catch(() => {});
		return undefined;
	}

	private async doRevoke(scope: RevokeScope): Promise<RevokeOutcome> {
		const { store } = this.deps;
		// Set BEFORE settling, so a refresh suspended on the network cannot persist when it resumes.
		this.abandoned = true;
		await this.settleInFlight();
		try {
			const token = this.orphanedRefreshToken ?? (await store.getTokens())?.refresh_token;
			// No refresh token at all: a pre-`offline_access` install. The access token expires within
			// the hour and cannot be revoked anyway (it is a JWT), so the local delete is the whole job.
			if (token === undefined) return "nothing-to-revoke";
			const clientId = await store.getClientId();
			// The endpoint answers 200 and revokes NOTHING for a client id that does not own the token,
			// so guessing one would report success over a no-op. Without the real id, say we failed.
			if (clientId === undefined) return "failed";
			const disc = await this.discovered();
			/*
			 * A DISCONNECT takes the whole grant: consent plus both token families. RFC 7009 cannot do
			 * that — it leaves the consent standing, so the server keeps reporting the grant active and
			 * the account page keeps listing this plugin. Falls through to the token-scoped revoke when
			 * the server does not serve the route, so the credential dies either way.
			 */
			if (scope === "grant" && disc.issuer !== undefined) {
				try {
					await revokeGrant(this.deps.f, disc.issuer, token);
					return "revoked";
				} catch (err) {
					console.warn(
						`[copal] grant revoke failed, falling back to token revoke: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			const endpoint = disc.revocation_endpoint;
			if (endpoint === undefined) return "failed";
			await revoke(this.deps.f, endpoint, clientId, token);
			return "revoked";
		} catch (err) {
			console.warn(`[copal] revoke failed: ${err instanceof Error ? err.message : String(err)}`);
			return "failed";
		}
	}

	/** Once per manager: a burst of concurrent 401s must not become a burst of notices. */
	private announceReauth(reason: ReauthReason): void {
		if (this.reauthAnnounced) return;
		this.reauthAnnounced = true;
		this.deps.onReauthRequired(reason);
	}
}
