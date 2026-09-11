/**
 * FNV-1a hash of raw bytes → an 8-hex-char fingerprint. Fast, deterministic, dependency-free. Used
 * LOCALLY only (never sent to the server) to detect whether a binary file changed since its last sync —
 * so a file the plugin just wrote from a pull doesn't echo back up as a spurious push.
 */
export function fnv1a(bytes: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= bytes[i]!;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
