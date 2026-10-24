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

/** How many bytes to hash before yielding to the event loop. ~1 ms of work on a slow phone. */
const CHUNK = 256 * 1024;

/**
 * `fnv1a`, but yielding to the event loop between chunks.
 *
 * ⚠️ Identical output to `fnv1a` — the hash is a fold, so chunking cannot change it, and a test pins
 * that. What it changes is that a 90 MB attachment no longer blocks the main thread for the whole fold.
 * Obsidian's UI runs on that thread, so the synchronous version froze the app mid-reconcile. ROADMAP P4.
 */
export async function fnv1aChunked(bytes: Uint8Array): Promise<string> {
	let hash = 0x811c9dc5;
	for (let start = 0; start < bytes.length; start += CHUNK) {
		const end = Math.min(start + CHUNK, bytes.length);
		for (let i = start; i < end; i++) {
			hash ^= bytes[i]!;
			hash = Math.imul(hash, 0x01000193);
		}
		// Let the UI breathe. One turn per chunk, so a big file costs turns rather than a frozen window.
		if (end < bytes.length) await Promise.resolve();
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
