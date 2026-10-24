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
/** The package root, for the manifest/package/versions files the submission is judged on. */
const ROOT = join(import.meta.dirname, "..");

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

	it("manifest, package.json and versions.json agree on the version (G9)", () => {
		// ⛔ They had drifted: manifest said 0.1.36 and package.json said 0.1.0. Nothing noticed, because
		// nothing compared them — and the release script's byte-compare between the beta and 1.0.0 trees
		// is only meaningful if the version a build CLAIMS is the version it was cut from.
		const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")) as {
			version: string;
			minAppVersion: string;
		};
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
		expect(pkg.version, "package.json must match manifest.json").toBe(manifest.version);

		const versions = JSON.parse(readFileSync(join(ROOT, "versions.json"), "utf8")) as Record<
			string,
			string
		>;
		expect(
			Object.keys(versions),
			"versions.json must have an entry for the version being shipped",
		).toContain(manifest.version);
		expect(
			versions[manifest.version],
			"and that entry must claim the same minAppVersion as the manifest",
		).toBe(manifest.minAppVersion);
	});

	it("the store description says what it does without naming the host app (G9)", () => {
		// The directory already tells the reader which app this is for, and the review guidelines ask
		// plugins not to repeat it. The em dash is the house rule.
		const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")) as {
			description: string;
		};
		expect(manifest.description).not.toMatch(/obsidian/i);
		expect(manifest.description, "no em dash in anything a reader sees").not.toContain("—");
		expect(manifest.description.length, "the directory truncates a long one").toBeLessThanOrEqual(
			250,
		);
		expect(manifest.description, "a description is a sentence").toMatch(/\.$/);
	});

	/**
	 * ⛔ G1. The register calls the README the likeliest single cause of store rejection, and it is the
	 * one artefact nothing else checks: it is prose, it is published to the public repo by the release
	 * script, and a reviewer reads it before anything else.
	 *
	 * These assert the DISCLOSURES the developer policies require, not the wording around them.
	 */
	describe("the published README (G1)", () => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");

		it("discloses the account, the subscription and the network use", () => {
			expect(readme, "an account requirement must be stated").toMatch(/account is required/i);
			expect(readme, "a paid subscription must be stated").toMatch(/subscription is required/i);
			expect(readme, "where note content goes must be named").toMatch(/api\.copal\.uk/);
			expect(readme, "and that it is sent at all").toMatch(
				/sends your note content over the network/i,
			);
		});

		it("states that nothing is downloaded or executed, and that there is no telemetry", () => {
			expect(readme).toMatch(/fetches no code at runtime|nothing is downloaded or executed/i);
			expect(readme).toMatch(/no analytics or telemetry/i);
		});

		it("links the privacy policy and the terms", () => {
			expect(readme).toMatch(/copal\.uk\/privacy/);
			expect(readme).toMatch(/copal\.uk\/terms/);
		});

		it("⛔ carries the credential-storage disclosure", () => {
			// The security scan's C2/C9 row recorded this as already being in the README when it was only
			// in the settings pane. The consequence — a synced vault carries the sign-in with it — is the
			// part a reader needs, so assert that and not just the file path.
			expect(readme).toMatch(/data\.json/);
			expect(readme, "the consequence, not just the location").toMatch(
				/sign-in travels with it|travels with any copy/i,
			);
			expect(readme, "and that signing out revokes it").toMatch(/revoke/i);
		});

		it("tells a reader how to install it", () => {
			expect(readme).toMatch(/community plugins/i);
			expect(readme, "BRAT is the route until the directory listing exists").toMatch(/BRAT/);
			expect(readme).toMatch(/manifest\.json/);
		});

		it("states the Obsidian version it needs, matching the manifest", () => {
			const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")) as {
				minAppVersion: string;
			};
			expect(readme, "a README claiming a different floor than the manifest misleads").toContain(
				manifest.minAppVersion,
			);
		});

		it("has no em dash, like every other thing a reader sees", () => {
			expect(readme).not.toContain("—");
		});
	});
});
