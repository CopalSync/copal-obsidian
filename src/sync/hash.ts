/** base64url of raw bytes (no padding). */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A stable content fingerprint (base64url SHA-256), used to detect whether a note was edited locally. */
export async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return base64url(new Uint8Array(digest));
}
