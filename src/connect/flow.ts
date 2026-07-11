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

  async start(): Promise<void> {
    const { f, store, openUrl, randomState } = this.deps;
    const disc = await discover(f);
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
    if (params.state !== pending.state) throw new Error("state mismatch — ignoring callback");
    if (!params.code) throw new Error("callback missing authorization code");
    const tokens = await exchangeCode(
      this.deps.f,
      pending.tokenEndpoint,
      pending.clientId,
      params.code,
      pending.verifier,
    );
    await this.deps.store.setTokens(tokens);
    this.pending = undefined;
    return tokens;
  }
}
