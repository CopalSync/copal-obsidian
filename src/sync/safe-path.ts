/**
 * Validate a note/file path that ORIGINATES FROM THE SERVER before it reaches any vault sink (create /
 * trash / read) or doc-store key. Obsidian's `normalizePath` canonicalizes separators but does **not**
 * strip `..` or reject absolute paths, so a hostile or misconfigured gateway could otherwise write
 * outside the vault (path traversal). This is the fail-closed gate: it returns the path unchanged when
 * safe, or `null` when the path is empty/whitespace-only, contains a `\` or a control char, is absolute
 * (`/…`, `~…`, `C:…`), or contains any `.`, `..`, or empty (`//`) segment.
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
	for (const seg of raw.split("/")) {
		if (seg === "" || seg === "." || seg === "..") return null;
	}
	return raw;
}
