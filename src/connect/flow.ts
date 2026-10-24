import { log } from "../log";
import type { TrustedUrl } from "../sync/safe-url";
import type { Tokens } from "../types";
import { buildAuthorizeUrl, CLIENT_ID, discover, exchangeCode } from "./oauth";
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
 * Orchestrates a single OAuth connect: `start()` discovers, generates PKCE + state, and opens the
 * authorize URL under the plugin's own client id (see `CLIENT_ID`); `handleCallback()` (fired by the `obsidian://` protocol
 * handler) validates the returned state, exchanges the code, and persists the tokens.
 */
export class ConnectFlow {
	private pending: Pending | undefined;

	constructor(private readonly deps: ConnectDeps) {}

	/**
	 * Discover, then send the browser to authorize under {@link CLIENT_ID}.
	 *
	 * There is no registration step. The plugin used to register itself and reuse the stored id, which
	 * needed a recovery for an id the server had forgotten (production was reset once and took seven
	 * clients with it) and another for one registered at a narrower scope. A CIMD client cannot go
	 * stale, so both went: the server fetches the plugin's document whenever it needs to.
	 */
	async start(): Promise<void> {
		const { f, openUrl, randomState } = this.deps;
		const disc = await discover(f);
		const clientId = CLIENT_ID;
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
			log.warn(
				`authorization callback reported an error: ${JSON.stringify(params.error).slice(0, 200)}`,
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
		// One write: the tokens, and the client they were issued to, which every refresh and revoke must
		// present. An install moving off a self-registered id moves here.
		await this.deps.store.completeSignIn(tokens, pending.clientId);
		return tokens;
	}
}
