import type { ClientReg, PkcePair, Tokens } from "../types";

export const API_BASE = "https://api.copal.uk";
export const REDIRECT_URI = "obsidian://copal-connect";
export const SCOPE = "vault.read vault.write";

interface Discovery {
  registration_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

export async function discover(f: typeof fetch): Promise<Discovery> {
  const res = await f(`${API_BASE}/.well-known/oauth-authorization-server`);
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
