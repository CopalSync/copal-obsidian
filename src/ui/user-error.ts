import { ApiError } from "../sync/api";

/**
 * Fixed, user-facing copy for an error. ROADMAP G7.
 *
 * ⚠️ Notices used to interpolate `err.message` directly, which meant a person saw
 * `Copal sync failed: request failed: 403`. That names neither the cause nor the remedy, and it is the
 * plugin's internal wording leaking into the product — the roadmap records one such message surfacing a
 * plan cap as a bare 403, which is precisely the case a user could have fixed themselves if told.
 *
 * Every branch says what happened AND what to do about it. The real error still goes to the console, so
 * nothing is lost for a bug report; what changes is that the Notice is written for the reader.
 */
export function userMessage(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.code === "VAULT_LIMIT_REACHED") {
			return "Your plan's vault limit is reached. Open Settings, then Copal, to manage your vaults, or upgrade at copal.uk.";
		}
		if (err.status === 401 || err.status === 403) {
			return "Your Copal sign-in is no longer valid. Open Settings, then Copal, and sign in again.";
		}
		if (err.status === 402) {
			return "Your Copal plan needs attention before this vault can sync. Check your billing at copal.uk.";
		}
		if (err.status === 404) {
			return "Copal could not find that. It may have been deleted on another device.";
		}
		if (err.status === 413) {
			return "That file is too large for Copal to sync. It stays in your vault.";
		}
		if (err.status === 429) {
			return "Copal is rate-limiting this vault. Syncing will resume shortly.";
		}
		if (err.status >= 500) {
			return "Copal is having trouble right now. Syncing will retry on its own.";
		}
	}
	// A fetch that never reached a server throws a TypeError rather than an ApiError.
	if (err instanceof TypeError) {
		return "Could not reach Copal. Check your connection. Syncing resumes automatically.";
	}
	return "Something went wrong syncing with Copal. Open the developer console for the details.";
}
