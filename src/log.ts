/**
 * The plugin's logger. ROADMAP G7.
 *
 * ⚠️ Two problems it fixes. The debug gate lived privately in `main.ts`, so every other module logged
 * unconditionally — a vault with one awkward filename printed a refusal on every reconcile for ever. And
 * `no-console` is now a lint error, so this is the one way out: a rule nothing can route around is the
 * only kind that stays true.
 *
 * `debug` and `info` are opt-in (`localStorage['copal-debug'] = '1'`). `warn` and `error` always emit —
 * they are real problems, and Obsidian's console is the only diagnostic a user can hand you from their
 * own vault. `warnOnce` is for the ones that would otherwise repeat per reconcile.
 */
const PREFIX = "[copal]";

/** Opt-in verbose logging. Wrapped because `localStorage` can throw in a restricted webview. */
export function debugEnabled(): boolean {
	try {
		return globalThis.localStorage?.getItem("copal-debug") === "1";
	} catch {
		return false;
	}
}

const seen = new Set<string>();

export const log = {
	debug(...args: unknown[]): void {
		if (debugEnabled()) console.debug(PREFIX, ...args);
	},
	info(...args: unknown[]): void {
		if (debugEnabled()) console.info(PREFIX, ...args);
	},
	warn(...args: unknown[]): void {
		console.warn(PREFIX, ...args);
	},
	error(...args: unknown[]): void {
		console.error(PREFIX, ...args);
	},
	/**
	 * Warn the first time for a given key, then stay quiet.
	 *
	 * For conditions that are per-FILE and re-checked on every reconcile — a refused path, an oversized
	 * attachment. Repeating those turns a real signal into the noise it hides in.
	 */
	warnOnce(key: string, ...args: unknown[]): void {
		if (seen.has(key)) return;
		seen.add(key);
		console.warn(PREFIX, ...args);
	},
	/** Test helper: forget what `warnOnce` has already said. */
	__resetOnce(): void {
		seen.clear();
	},
};
