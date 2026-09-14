import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Obsidian's review guidelines, asserted against the source rather than remembered.
 *
 * These are the rules a human reviewer applies by reading the code, which makes them exactly the rules
 * that drift back in the moment nobody is reading it. Source-level checks are crude, but the thing they
 * are protecting is a submission, and a rule nothing enforces is a rule that will be broken again.
 *
 * (This file replaces a `smoke.test.ts` that asserted `1 + 1 === 2`.)
 */
const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return sourceFiles(full);
		return entry.endsWith(".ts") ? [full] : [];
	});
}

const files = sourceFiles(SRC).map((path) => ({
	path: path.slice(SRC.length + 1),
	text: readFileSync(path, "utf8"),
}));

describe("Obsidian store rules", () => {
	/**
	 * Modals and settings get their title from the API, which renders it in the chrome. A hand-rolled
	 * heading element sits INSIDE the content and duplicates whatever the chrome already shows.
	 */
	it("no hand-rolled heading elements", () => {
		const offenders = files
			.filter((f) => /createEl\(\s*["'`]h[1-6]["'`]/.test(f.text))
			.map((f) => f.path);
		expect(offenders, "use setTitle()/setHeading() rather than a heading element").toEqual([]);
	});

	/**
	 * Obsidian prefixes every command with the plugin name already, so a name carrying it again renders
	 * as "Copal: Copal: Sync now" in the palette. The id is namespaced by the plugin id for the same
	 * reason, so `copal-sync-now` becomes `copal:copal-sync-now`.
	 */
	it("command names and ids do not repeat the plugin name", () => {
		const text = files.map((f) => f.text).join("\n");
		const names = [...text.matchAll(/addCommand\(\{[^}]*?name:\s*"([^"]+)"/gs)].map((m) => m[1]);
		expect(names.length, "no commands found — this test would pass vacuously").toBeGreaterThan(0);
		expect(names.filter((n) => /copal/i.test(n ?? ""))).toEqual([]);

		const ids = [...text.matchAll(/addCommand\(\{[^}]*?id:\s*"([^"]+)"/gs)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(0);
		expect(ids.filter((i) => /^copal[-:]/i.test(i ?? ""))).toEqual([]);
	});

	/**
	 * A `Component` (views, the plugin) must register DOM listeners through `registerDomEvent`, which ties
	 * them to its lifecycle. Raw ones outlive the view — and in the search pane the results re-render on
	 * every keystroke, so one listener per hit per render grows with how much the user types.
	 *
	 * Sockets are exempt: `ws.addEventListener` is not a DOM element and those are closed explicitly.
	 * `Modal` is exempt because it is not a `Component`; `onClose` empties `contentEl` instead.
	 */
	it("views register DOM listeners through registerDomEvent", () => {
		const offenders = files
			.filter(
				(f) =>
					f.path.endsWith("search-view.ts") &&
					/\bel\.addEventListener|\bitem\.addEventListener|inputEl\.addEventListener|resultsEl\.addEventListener|btn\.addEventListener/.test(
						f.text,
					),
			)
			.map((f) => f.path);
		expect(offenders).toEqual([]);
	});

	/**
	 * ⛔ **One writer for `data.json`, kept to one writer.** Five persisters used to call
	 * `loadData`/`saveData` themselves, each doing its own read-modify-write of the whole record — so a
	 * `delete data.tokens` in `signOut` could be spread back over by any of them, and sign-out reported
	 * success with the credential still on disk in a file that syncs between devices (S3).
	 *
	 * Asserted as an exact COUNT rather than "only in file X" for two reasons. A whole-file allowance
	 * would let a sixth read-modify-write be added anywhere in that file and still pass; and a bare
	 * absence assertion (`offenders === []`) goes green the moment someone renames or deletes the
	 * wiring, which is the failure mode this suite already guards against elsewhere with the
	 * "would pass vacuously" check.
	 */
	it("data.json is loaded and saved in exactly one place", () => {
		// Comments are stripped first: this very rule, and the docblocks explaining it, name both
		// methods, and a rule that counted its own documentation would be unmaintainable.
		const code = (text: string): string =>
			text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
		const sites = files.flatMap((f) =>
			[...code(f.text).matchAll(/\b(loadData|saveData)\s*\(/g)].map((m) => `${f.path}:${m[1]}`),
		);
		expect(
			sites.sort(),
			"every write to data.json goes through PluginDataStore, wired once in data/wire-persistence.ts",
		).toEqual(["main.ts:loadData", "main.ts:saveData"]);
	});

	/** The house copy rule, and it reaches the store listing through the manifest description. */
	it("no em-dashes in user-visible strings", () => {
		const offenders = files
			.filter((f) => /(?:text|name|title|cta|placeholder):\s*"[^"]*—/.test(f.text))
			.map((f) => f.path);
		expect(offenders).toEqual([]);
	});
});
