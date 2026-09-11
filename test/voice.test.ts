import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sources(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

/**
 * Strip comments, so the RULE can be explained in prose without breaking itself.
 *
 * ⚠️ Line comments are matched only where `//` follows whitespace or a line start, so `https://…`
 * inside a string survives. `apps/console/test/voice.test.ts` carries the same regex and the same
 * warning: getting it wrong silently truncates a file and quietly stops scanning the rest of it.
 * The earlier version here missed TRAILING comments entirely and reported ten false positives.
 */
function code(source: string): string {
	return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|\s)\/\/[^\n]*/g, "$1");
}

/**
 * ⛔ NO EM DASH IN ANYTHING A READER SEES.
 *
 * `apps/console` has had this test for a while; the plugin never did, which is why three em dashes
 * were sitting in Notices and setting descriptions until a user read one off a phone screen and
 * complained. The console's copy was protected and the plugin's was not, in the same product.
 *
 * Comments are exempt — this file is full of them and the house style uses the dash freely in prose
 * that only developers read.
 */
describe("the house voice", () => {
	it("uses no em dash in anything a reader sees", () => {
		const offenders = sources(SRC)
			.filter((path) => code(readFileSync(path, "utf8")).includes("—"))
			.map((path) => path.slice(SRC.length + 1));
		expect(offenders).toEqual([]);
	});
});
