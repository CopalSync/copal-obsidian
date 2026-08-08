import type { ClientReg, PkcePair, Tokens } from "../types";

export const API_BASE = "https://api.copal.uk";
export const REDIRECT_URI = "obsidian://copal-connect";
export const SCOPE = "vault.read vault.write";

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
  const res = await f(
    `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
  );
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
      // `obsidian://copal-connect` is a custom scheme, not HTTPS. OIDC defaults application_type
      // to "web", which forbids that, so a native client that leaves this out is refused at
      // registration — and MCP 2026-07-28 requires clients to declare it.
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
    }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return toTokens(await res.json());
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
    }).toString(),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  return toTokens(await res.json());
}
