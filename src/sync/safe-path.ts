/**
 * Validate a note/file path that ORIGINATES FROM THE SERVER before it reaches any vault sink (create /
 * trash / read) or doc-store key. Obsidian's `normalizePath` canonicalizes separators but does **not**
 * strip `..` or reject absolute paths, so a hostile or misconfigured gateway could otherwise write
 * outside the vault (path traversal). This is the fail-closed gate: it returns the path unchanged when
 * safe, or `null` when the path is empty/whitespace-only, contains a `\` or a control char, is absolute
 * (`/…`, `~…`, `C:…`), contains an empty (`//`) segment, has a **dot-prefixed segment** (`.obsidian`,
 * `.trash`, `.git`, `.DS_Store`; this subsumes `.`/`..` traversal), or has a **folder segment in the
 * shape of a Windows 8.3 short name** (`OBSIDI~1`).
 *
 * ⚠️ The dot-prefix rule is the S1 fix, and it is case-free on purpose. It replaced exact-case
 * `.obsidian/` and `.trash/` prefix checks, and on a case-insensitive filesystem (macOS, Windows)
 * `.Obsidian/plugins/copal/main.js` IS this plugin's own code, so a server path could rewrite the plugin
 * and have it run on the next load. Obsidian's own `getFiles()` never returns a dot-prefixed entry and
 * its vault events never fire for one, so nothing local ever pushes such a path: refusing one inbound
 * is symmetric, not a new restriction.
 *
 * ⚠️ The 8.3 rule exists because NTFS gives a dot-folder a short alias, and `OBSIDI~1` (or `GIT~1`, for
 * a vault kept in git) opens the folder itself while containing no dot at all. Only FOLDER segments are
 * checked: an alias is only dangerous as a directory to write into, and a note may well be called
 * `draft~1.md`.
 *
 * A trailing dot or space is NOT refused here, though NTFS strips both: those names are legal on macOS
 * and Linux, and refusing them would silently stop a real folder syncing. They matter only where they
 * would alias the config folder, which `isConfigDirPath` handles.
 *
 * Pure (no `obsidian` import) so it's unit-tested in isolation; sinks pair it with `normalizePath` for
 * defense-in-depth. Callers DROP + log an unsafe path — never throw into the sync engine's hot path.
 */
export function safePath(raw: string): string | null {
	if (typeof raw !== "string") return null;
	if (raw.trim() === "") return null;
	if (raw.includes("\\")) return null; // backslash → Windows/UNC separator, never a vault path
	// Reject control chars (NUL…US + DEL) — filesystem / header smuggling.
	for (let i = 0; i < raw.length; i++) {
		const c = raw.charCodeAt(i);
		if (c <= 0x1f || c === 0x7f) return null;
	}
	if (raw.startsWith("/")) return null; // POSIX absolute
	if (raw.startsWith("~")) return null; // home expansion
	if (/^[A-Za-z]:/.test(raw)) return null; // Windows drive letter
	const segments = raw.split("/");
	for (const [i, seg] of segments.entries()) {
		if (seg === "") return null; // empty segment ("//")
		if (seg.startsWith(".")) return null; // hidden file or folder, and `.`/`..`
		if (i < segments.length - 1 && SHORT_NAME.test(seg)) return null; // a folder's 8.3 alias
	}
	return raw;
}

/** The 8.3 alias shape: up to six characters, `~`, a number, and an optional extension of up to three. */
const SHORT_NAME = /^[^.~]{1,6}~\d+(\.[^.]{1,3})?$/;

/**
 * True when `path`'s FIRST segment names the vault's config folder (`app.vault.configDir`, which
 * Obsidian's "Override config folder" setting can rename), compared the way the filesystem underneath
 * would compare it: NFKC and lower-cased (APFS folds by Unicode rules, so `ſ` is an `s` there), with the
 * suffixes NTFS ignores removed (a trailing run of dots and spaces, and a `:stream` part, which opens
 * the folder itself).
 *
 * `safePath` already refuses the default `.obsidian` in every case. This is the second line of defence
 * at the sinks, keyed on what the folder is called now rather than on the rename keeping a leading dot.
 */
export function isConfigDirPath(path: string, configDir: string): boolean {
	return fsName(path.split("/")[0] ?? "") === fsName(configDir);
}

function fsName(segment: string): string {
	const stream = segment.indexOf(":");
	const name = stream === -1 ? segment : segment.slice(0, stream);
	return name
		.replace(/[. ]+$/, "")
		.normalize("NFKC")
		.toLowerCase();
}
