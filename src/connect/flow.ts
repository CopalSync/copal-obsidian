import type { Tokens } from "../types";
import { buildAuthorizeUrl, discover, exchangeCode, registerClient } from "./oauth";
import { createPkce } from "./pkce";
import type { TokenStore } from "./store";

export interface ConnectDeps {
	f: typeof fetch;
	store: TokenStore;
	/** Open the authorize URL in the system browser (Obsidian: `window.open`). */
	openUrl: (url: string) => void;
	/** CSRF state generator (Obsidian: `crypto.randomUUID`). */
	randomState: () => string;
}

/** In-flight connect attempt: the PKCE verifier + CSRF state + the endpoints/client resolved at start. */
interface Pending {
	verifier: string;
	state: string;
	tokenEndpoint: string;
	clientId: string;
}

/**
 * Orchestrates a single OAuth connect: `start()` discovers, ensures a registered client, generates
 * PKCE + state, and opens the authorize URL; `handleCallback()` (fired by the `obsidian://` protocol
 * handler) validates the returned state, exchanges the code, and persists the tokens.
 */
export class ConnectFlow {
	private pending: Pending | undefined;

	constructor(private readonly deps: ConnectDeps) {}

	/**
	 * ⛔ **A STORED CLIENT THAT THE SERVER HAS FORGOTTEN IS A PERMANENT DEAD END, AND WAS.**
	 *
	 * The registration used to be kept forever and reused whenever it existed. When the server's
	 * client row goes away — production was reset on 2026-08-31 and took seven OAuth clients with it
	 * — every later connect presents an id the authorization server does not recognise, and there
	 * was no path back:
	 *
	 *   - The failure happens at `/oauth2/authorize`, which refuses an unknown client BEFORE it will
	 *     redirect anywhere that client nominated. So the error never reaches `handleCallback` and
	 *     the plugin cannot see it.
	 *   - `store.clientId` is explicitly kept across disconnects, so disconnecting and reconnecting
	 *     reuses the same dead id.
	 *   - Better Auth reports it as `invalid_client` / **"client_id is required"**, which reads like
	 *     a missing parameter and sends whoever debugs it looking for one. Measured against
	 *     production: an unknown client gives that message; a genuinely missing one gives
	 *     `invalid_request` / "client_id: client_id is required".
	 *
	 * So the only exit was deleting `data.json` by hand, on a phone.
	 *
	 * The fix is to notice a connect that never came back. `start()` marks an attempt pending and
	 * `handleCallback` clears it; a second `start()` that finds the mark still set knows the last
	 * attempt died somewhere it could not observe, and discards the registration before trying
	 * again. Costs one extra registration after a genuine failure, and nothing at all in the happy
	 * path — and a user who abandons the browser tab simply re-registers next time, which is
	 * harmless for a public client.
	 */
	async start(): Promise<void> {
		const { f, store, openUrl, randomState } = this.deps;
		const disc = await discover(f);

		/*
		 * ⛔ `undefined` IS NOT `false`, and collapsing the two leaves every already-broken install
		 * broken for one more attempt.
		 *
		 * `true`  — the last attempt opened the browser and never came back. Discard.
		 * `undefined` — this install has never recorded an attempt, so its stored registration was
		 *   written by a build that predates this mechanism and there is no evidence it still works.
		 *   Discard once; from here on the mark governs. This is the migration, and without it the
		 *   first connect after updating reuses the dead id and fails exactly as before — the fix
		 *   would only take effect on the SECOND try, which is not a fix for someone who is stuck.
		 * `false` — the last attempt completed. Keep it.
		 */
		const lastAttempt = await store.getConnectAttemptPending();
		if (lastAttempt !== false) {
			await store.setClientId(undefined);
		}
		await store.setConnectAttemptPending(true);

		let clientId = await store.getClientId();
		if (!clientId) {
			const reg = await registerClient(f, disc.registration_endpoint);
			clientId = reg.client_id;
			await store.setClientId(clientId);
		}
		const pkce = await createPkce();
		const state = randomState();
		this.pending = {
			verifier: pkce.verifier,
			state,
			tokenEndpoint: disc.token_endpoint,
			clientId,
		};
		openUrl(buildAuthorizeUrl(disc.authorization_endpoint, clientId, pkce, state));
	}

	async handleCallback(params: {
		code?: string | undefined;
		state?: string | undefined;
		error?: string | undefined;
	}): Promise<Tokens> {
		if (params.error) throw new Error(`authorization failed: ${params.error}`);
		const pending = this.pending;
		if (!pending) throw new Error("no pending connect attempt");
		if (params.state !== pending.state) throw new Error("state mismatch, ignoring callback");
		if (!params.code) throw new Error("callback missing authorization code");
		const tokens = await exchangeCode(
			this.deps.f,
			pending.tokenEndpoint,
			pending.clientId,
			params.code,
			pending.verifier,
		);
		await this.deps.store.setTokens(tokens);
		// The attempt came back. Clear the mark so the NEXT connect keeps this registration rather
		// than treating it as the corpse of a failed one.
		await this.deps.store.setConnectAttemptPending(false);
		this.pending = undefined;
		return tokens;
	}
}
