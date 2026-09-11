import { describe, expect, it } from "vitest";
import { safePath } from "../../src/sync/safe-path";

describe("safePath", () => {
	const reject = [
		"../secret.md",
		"a/../../b.md",
		"/etc/passwd",
		"C:\\Windows\\x.md",
		"a\\b.md",
		"~/x.md",
		"",
		"   ",
		"a//b.md",
		"./a.md",
		"a/.",
		"a/..",
		"..",
		".",
		"a/\u0000b.md",
		"\u0007bell.md",
		".md",
	];
	for (const p of reject) {
		it(`rejects ${JSON.stringify(p)}`, () => {
			expect(safePath(p)).toBeNull();
		});
	}

	// The accept half guards against an over-strict guard silently breaking legitimate notes.
	const accept = [
		"note.md",
		"dir/sub/note.md",
		"weird name (conflicted copy).md",
		"Ünïcödé note.md",
		"folder with spaces/日本語.md",
		"attachments/image.png",
	];
	for (const p of accept) {
		it(`accepts ${JSON.stringify(p)}`, () => {
			expect(safePath(p)).toBe(p);
		});
	}
});
