import type { Tokens } from "../types";
import { discover, refresh, TokenRefreshError } from "./oauth";
import type { TokenStore } from "./store";

/** Refresh this long before `expires_at`, so a call in flight does not race the expiry. */
const REFRESH_SKEW_MS = 60_000;

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
		await store.setTokens(merged);
		return merged.access_token;
	}

	/** Once per manager: a burst of concurrent 401s must not become a burst of notices. */
	private announceReauth(reason: ReauthReason): void {
		if (this.reauthAnnounced) return;
		this.reauthAnnounced = true;
		this.deps.onReauthRequired(reason);
	}
}
