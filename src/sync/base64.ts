/**
 * Chunk-safe base64 ↔ bytes for the batched CRDT handshake, whose `sv`/`update` fields ride as base64 in
 * JSON (`POST /ycrdt/sync`).
 *
 * `String.fromCharCode(...bytes)` overflows the call stack on large inputs, so encoding goes in bounded
 * chunks — a page of 100 Yjs updates reaches that. Standard base64, NOT the url-safe variant in `hash.ts`
 * and `pkce.ts`: this has to round-trip through the gateway's `atob`/`btoa`.
 *
 * ⚠️ Deliberately a near-copy of the gateway's `src/lib/base64.ts`. The plugin shares no library with the
 * Workers, and a workspace package for twenty lines would cost more than the duplication does. If one
 * changes, change both.
 */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/** ⚠️ Throws on malformed input (`atob` raises) — a caller decoding a server payload must catch. */
export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
