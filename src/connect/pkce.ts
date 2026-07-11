import type { PkcePair } from "../types";

/** base64url of raw bytes (no padding) — the PKCE + WebCrypto encoding. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 PKCE pair: a high-entropy verifier + its S256 challenge. */
export async function createPkce(): Promise<PkcePair> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}
