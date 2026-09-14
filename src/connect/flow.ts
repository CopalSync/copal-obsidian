import type { TrustedUrl } from "../sync/safe-url";
import type { Tokens } from "../types";
import { buildAuthorizeUrl, discover, exchangeCode, registerClient, SCOPE } from "./oauth";
import { createPkce } from "./pkce";
import type { TokenStore } from "./store";

export interface ConnectDeps {
	f: typeof fetch;
	store: TokenStore;
	/** Open the authorize URL in the system browser (Obsidian: `window.open`). Takes a `TrustedUrl`
	 *  because this is the sink where a bad value EXECUTES rather than leaks — see `openExternal`. */
	openUrl: (url: TrustedUrl) => void;
	/** CSRF state generator (Obsidian: `crypto.randomUUID`). */
	randomState: () => string;
	/** Injected for tests; the pending attempt's expiry is measured against it. */
	now?: () => number;
}

/** In-flight connect attempt: the PKCE verifier + CSRF state + the endpoints/client resolved at start. */
interface Pending {
	verifier: string;
	state: string;
	/** Captured at `start` and used a whole user round trip later, so it carries its check with it. */
	tokenEndpoint: TrustedUrl;
	clientId: string;
	/** When this attempt stops being usable. See {@link PENDING_TTL_MS}. */
	expiresAt: number;
}

/**
 * How long a started connect stays answerable.
 *
 * The attempt holds a live PKCE verifier, and it used to be held until the plugin was unloaded — so a
 * connect abandoned in a browser tab in the morning was still redeemable that evening by anything that
 * could reach the `obsidian://` deep link. Ten minutes is comfortably longer than a sign-in takes and
 * shorter than a walk away from the machine; it is also the window authorization codes themselves are
 * usually given.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * What the user is told when the callback carries an `error`.
 *
 * ⛔ **FIXED COPY, DELIBERATELY.** `params.error` arrives on `obsidian://copal-connect?error=…`, and
 * any app or page on the device can invoke that URL. Interpolating it into the thrown message put a
 * stranger's text into a Notice inside the user's vault, which is a phishing surface with the
 * plugin's own credibility behind it ("Your vault is locked, call this number"). The raw value is
 * logged for debugging and never rendered.
 */
const AUTHORIZATION_FAILED = "Sign-in did not complete. Please try connecting again.";

/**
 * Scope strings compared as SETS, because that is what the server compares. `undefined` normalises
 * to `""`, which matches nothing real — an install that predates `clientScope` has no evidence its
 * registration is usable, so it re-registers once. That is the migration.
 */
function normaliseScope(scope: string | undefined): string {
	return (scope ?? "").split(" ").filter(Boolean).sort().join(" ");
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
	 * ⛔ **A REGISTRATION IS ALSO DEAD IF IT WAS MADE WITH A DIFFERENT SCOPE**, and that failure
	 * looks nothing like the one above. `/oauth2/authorize` validates the requested scope against
	 * `client.scopes` captured at registration and refuses a mismatch with `invalid_scope`. When
	 * `offline_access` was added to `SCOPE` on 2026-09-12, every existing install held a client
	 * registered narrower — and every one of them had `connectAttemptPending === false`, so the
	 * mark below would have happily kept it and turned a silent hourly breakage into a hard
	 * "cannot sign in at all". Hence `clientScope`: a registration is reusable only when it was
	 * made with the scope we are about to request.
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
		const lastAttempt = store.getConnectAttemptPending();
		/*
		 * Compared NORMALISED, so reordering `SCOPE` is not a change. A raw string compare would
		 * re-register every install on the planet for a purely cosmetic edit, and the authorization
		 * server accumulates a client row for each one.
		 */
		const scopeChanged = normaliseScope(store.getClientScope()) !== normaliseScope(SCOPE);
		// One write, not two: discarding a registration we cannot trust and marking the attempt pending
		// are the same decision, and two awaited writes here rewrote the record twice per connect.
		await store.beginConnectAttempt(lastAttempt !== false || scopeChanged);

		let clientId = store.getClientId();
		if (!clientId) {
			const reg = await registerClient(f, disc.registration_endpoint);
			clientId = reg.client_id;
			await store.setClientRegistration(clientId, SCOPE);
		}
		const pkce = await createPkce();
		const state = randomState();
		this.pending = {
			verifier: pkce.verifier,
			state,
			tokenEndpoint: disc.token_endpoint,
			clientId,
			expiresAt: (this.deps.now?.() ?? Date.now()) + PENDING_TTL_MS,
		};
		openUrl(buildAuthorizeUrl(disc.authorization_endpoint, clientId, pkce, state));
	}

	async handleCallback(params: {
		code?: string | undefined;
		state?: string | undefined;
		error?: string | undefined;
	}): Promise<Tokens> {
		if (params.error !== undefined) {
			console.warn(
				`[copal] authorization callback reported an error: ${JSON.stringify(params.error).slice(0, 200)}`,
			);
			throw new Error(AUTHORIZATION_FAILED);
		}
		const pending = this.pending;
		if (!pending) throw new Error("no pending connect attempt");
		/*
		 * State is checked BEFORE the attempt is consumed, and a mismatch deliberately leaves it
		 * standing. Consuming on a bad state would let anything that can fire the deep link cancel a
		 * sign-in that is legitimately in progress — trading a replay window for a denial of service.
		 */
		if (params.state !== pending.state) throw new Error("state mismatch, ignoring callback");
		if ((this.deps.now?.() ?? Date.now()) > pending.expiresAt) {
			this.pending = undefined;
			throw new Error("this sign-in attempt has expired, please try connecting again");
		}
		if (!params.code) throw new Error("callback missing authorization code");
		/*
		 * SINGLE USE. Cleared before the exchange, not after: a failed exchange used to leave the
		 * verifier in place, so the same code could be presented again and again.
		 */
		this.pending = undefined;
		const tokens = await exchangeCode(
			this.deps.f,
			pending.tokenEndpoint,
			pending.clientId,
			params.code,
			pending.verifier,
		);
		// One write. The attempt came back, so the mark is cleared in the same breath as the tokens land
		// — the NEXT connect then keeps this registration rather than treating it as a failed one's corpse.
		await this.deps.store.completeSignIn(tokens);
		return tokens;
	}
}
