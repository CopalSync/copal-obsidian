import { describe, expect, it } from "vitest";
import { isConfigDirPath, safePath } from "../../src/sync/safe-path";

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
		"\x7f.md",
		// S1: the config folder in any case. On a case-insensitive filesystem `.Obsidian` IS `.obsidian`,
		// so an exact-case check let a server path overwrite this plugin's own `main.js`.
		".obsidian/plugins/copal/main.js",
		".Obsidian/plugins/copal/main.js",
		".OBSIDIAN/app.json",
		// Any dot-prefixed segment: hidden folders and files are never vault files.
		".trash/old.png",
		".git/hooks/pre-commit",
		"notes/.hidden/x.png",
		".DS_Store",
		// A Windows 8.3 short name aliases a dot-folder: `OBSIDI~1` opens `.obsidian` on NTFS.
		"OBSIDI~1/plugins/copal/main.js",
		"obsidi~1/plugins/copal/main.js",
		"GIT~1/hooks/pre-commit",
		"notes/TRASH~12/x.png",
		"MYCONF~1.D/plugins/x.js",
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
		"dir.with.dots/file.name.png",
		"v1.2/notes.md",
		// A tilde is only refused in the 8.3 alias shape of a FOLDER; a file may carry one.
		"drafts/draft~1.md",
		"notes~old/a.md",
		// A trailing dot or space is legal on macOS and Linux, and refusing it would silently stop a
		// real folder syncing. Only the config-folder comparison strips them (see `isConfigDirPath`).
		"Archive./a.md",
	];
	for (const p of accept) {
		it(`accepts ${JSON.stringify(p)}`, () => {
			expect(safePath(p)).toBe(p);
		});
	}
});

describe("isConfigDirPath", () => {
	// Obsidian's "Override config folder" renames `.obsidian`, and `app.vault.configDir` is the authority
	// on what it is now. These cases name a folder the filesystem would open AS that folder.
	const configDir = ".settings";
	const hits = [
		".settings/plugins/copal/main.js",
		".Settings/plugins/copal/main.js",
		".SETTINGS/app.json",
		// NTFS strips a trailing dot or space, and `:` opens a stream of the folder itself.
		".settings./plugins/x.js",
		".settings /plugins/x.js",
		".settings. ./plugins/x.js",
		".settings::$INDEX_ALLOCATION/plugins/x.js",
		// APFS folds case by Unicode rules: U+017F (long s) is an `s` there.
		".ſettings/plugins/x.js",
	];
	for (const p of hits) {
		it(`matches ${JSON.stringify(p)}`, () => {
			expect(isConfigDirPath(p, configDir)).toBe(true);
		});
	}

	it("matches a decomposed spelling of a composed config folder (macOS stores NFD)", () => {
		expect(isConfigDirPath(".cönfig/x.js".normalize("NFD"), ".cönfig".normalize("NFC"))).toBe(true);
	});

	const misses = ["settings/x.md", "notes/.settings/x.md", ".settings2/x.js", "a.md"];
	for (const p of misses) {
		it(`does not match ${JSON.stringify(p)}`, () => {
			expect(isConfigDirPath(p, configDir)).toBe(false);
		});
	}
});
