/**
 * This install's device id. ROADMAP N5.
 *
 * ⛔ **It used to live in `data.json`, which travels with the vault.** Two devices syncing one folder
 * through iCloud, Obsidian Sync, Dropbox or git therefore shared one id, and the register rated that
 * "low" because the visible effects were cosmetic: a shared presence colour, and conflict copies named
 * after the wrong device.
 *
 * **P5 changed the rating.** The change bus now filters a frame whose origin is `plugin:<deviceId>`,
 * because the gateway stamps it so the originating device can drop its own echoes. With a shared id,
 * device B classifies device A's genuine changes as its own echo and DISCARDS THEM. That is silent data
 * loss, not a cosmetic defect, so the field had to move.
 *
 * Three layers, in order:
 *
 *  1. **Memory**, so the id is stable within a session no matter what the platform does.
 *  2. **`localStorage`**, which is per-device and never inside the vault, so it cannot be copied with it.
 *  3. **A fresh id**, if neither has one.
 *
 * ⚠️ A stored `data.json` id is deliberately NOT adopted. Adopting it would preserve continuity for the
 * single-device case and reintroduce the collision for exactly the copied-vault case this exists to fix.
 * Minting fresh costs a new presence colour and lets one round of our own old echoes through, both of
 * which are harmless; keeping the old one risks dropping another device's edits.
 */
const KEY = "copal-device-id";

let cached: string | undefined;

/** Read/write `localStorage` defensively: a restricted webview can throw on access, not just return null. */
function fromStorage(): string | undefined {
	try {
		return globalThis.localStorage?.getItem(KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

function toStorage(id: string): void {
	try {
		globalThis.localStorage?.setItem(KEY, id);
	} catch {
		/* no storage here; the in-memory cache still keeps it stable for this session */
	}
}

/**
 * This device's id, stable for the session and across sessions wherever `localStorage` survives.
 *
 * Synchronous on purpose: it writes nothing to `data.json`, so there is nothing to await, and callers
 * that used to hold an awaited copy can read it directly.
 */
export function deviceId(): string {
	if (cached !== undefined) return cached;
	const stored = fromStorage();
	if (stored !== undefined && stored !== "") {
		cached = stored;
		return cached;
	}
	const fresh = crypto.randomUUID();
	cached = fresh;
	toStorage(fresh);
	return fresh;
}

/** Test helper: forget the session cache so the storage layers can be exercised. */
export function __resetDeviceId(): void {
	cached = undefined;
}
