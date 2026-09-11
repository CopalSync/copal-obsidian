import type { Change, ManifestEntry, NoteContent, SearchHit } from "./api";
import { safePath } from "./safe-path";

/**
 * Runtime validators for the server's JSON responses. The gateway is trusted structurally today (`as`
 * casts), so a compromised/buggy server response is applied blindly — combined with the path sinks that
 * is a real risk. These hand-rolled guards (no zod — the plugin bundle stays lean) validate the critical
 * fields (`path` via `safePath`, `op` enum, numeric `seq`/`head`), coerce optional fields defensively,
 * and **drop** malformed entries rather than throw — order among the survivors is preserved.
 */

function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null;
}

function num(x: unknown, fallback = 0): number {
	return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

/** A string field that must also be a safe vault path, else `null` (→ the entry is dropped). */
function safeStr(x: unknown): string | null {
	return typeof x === "string" ? safePath(x) : null;
}

/** Validate one journal change frame; returns `null` (→ dropped) if path is unsafe or op unknown. */
export function parseChange(x: unknown): Change | null {
	if (!isRecord(x)) return null;
	const path = safeStr(x.path);
	if (path === null) return null;
	if (x.op !== "put" && x.op !== "delete") return null;
	if (typeof x.seq !== "number" || !Number.isFinite(x.seq)) return null;
	const change: Change = {
		seq: x.seq,
		path,
		op: x.op,
		origin: typeof x.origin === "string" ? x.origin : "",
		ts: num(x.ts),
	};
	if (typeof x.version === "string") change.version = x.version;
	if (typeof x.size === "number") change.size = x.size;
	if (typeof x.mtime === "number") change.mtime = x.mtime;
	return change;
}

/** Validate a `{ head, manifest[], cursor? }` page; drops entries without a safe string path. A non-empty
 *  string `cursor` signals more pages remain (the manifest is cursor-paged so any vault size fully syncs). */
export function parseManifest(x: unknown): {
	head: number;
	manifest: ManifestEntry[];
	cursor?: string;
} {
	if (!isRecord(x)) return { head: 0, manifest: [] };
	const manifest: ManifestEntry[] = [];
	if (Array.isArray(x.manifest)) {
		for (const e of x.manifest) {
			if (!isRecord(e)) continue;
			const path = safeStr(e.path);
			if (path === null) continue;
			manifest.push({
				path,
				version: typeof e.version === "string" ? e.version : "",
				size: num(e.size),
				mtime: num(e.mtime),
			});
		}
	}
	return {
		head: num(x.head),
		manifest,
		...(typeof x.cursor === "string" && x.cursor !== "" ? { cursor: x.cursor } : {}),
	};
}

/** Validate a `{ head, changes[] }` delta; filters malformed frames, preserves order. */
export function parseChangesResponse(x: unknown): { head: number; changes: Change[] } {
	if (!isRecord(x)) return { head: 0, changes: [] };
	const changes: Change[] = [];
	if (Array.isArray(x.changes)) {
		for (const c of x.changes) {
			const parsed = parseChange(c);
			if (parsed) changes.push(parsed);
		}
	}
	return { head: num(x.head), changes };
}

/** Validate a `GET /search` response (`{ path, title, snippet }[]`); drops any hit whose path is unsafe. */
export function parseSearch(x: unknown): SearchHit[] {
	if (!Array.isArray(x)) return [];
	const hits: SearchHit[] = [];
	for (const h of x) {
		if (!isRecord(h)) continue;
		const path = safeStr(h.path);
		if (path === null) continue;
		hits.push({
			path,
			title: typeof h.title === "string" ? h.title : path,
			snippet: typeof h.snippet === "string" ? h.snippet : "",
		});
	}
	return hits;
}

/** Validate a `/sync/batch` GET response; keeps only found notes with a safe path + string content. */
export function parseBatch(x: unknown): NoteContent[] {
	if (!isRecord(x)) return [];
	const notes: NoteContent[] = [];
	if (Array.isArray(x.get)) {
		for (const g of x.get) {
			if (!isRecord(g) || g.ok !== true || !isRecord(g.note)) continue;
			const note = g.note;
			const path = safeStr(note.path);
			if (path === null || typeof note.content !== "string") continue;
			const nc: NoteContent = {
				path,
				content: note.content,
				mtime: num(note.mtime),
				size: num(note.size),
			};
			if (typeof note.version === "string") nc.version = note.version;
			notes.push(nc);
		}
	}
	return notes;
}
