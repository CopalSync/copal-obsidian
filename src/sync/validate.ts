import type { Change, ManifestEntry, SearchHit, Vault, YSyncResult } from "./api";
import { assertWssUrl } from "./safe-url";
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

/**
 * Validate a `POST /ycrdt/sync` response. Each item is kept only if its `path` is safe and its binary
 * fields are strings; a malformed item is DROPPED rather than thrown, like every validator here, and the
 * caller then simply re-enqueues that path (nothing was applied, so nothing diverged).
 *
 * ⚠️ `update`/`sv` are NOT decoded here. They are base64 that `Y.applyUpdate` must accept, and decoding
 * in the validator would either throw — losing the whole page for one bad item — or need a second error
 * channel. The caller decodes per item inside its own try.
 */
export function parseYSync(x: unknown): YSyncResult[] {
	if (!isRecord(x) || !Array.isArray(x.items)) return [];
	const items: YSyncResult[] = [];
	for (const raw of x.items) {
		if (!isRecord(raw)) continue;
		const path = safePath(typeof raw.path === "string" ? raw.path : "");
		if (path === null) continue;
		const item: YSyncResult = { path, ok: raw.ok === true };
		if (typeof raw.update === "string") item.update = raw.update;
		if (typeof raw.sv === "string") item.sv = raw.sv;
		if (typeof raw.code === "string") item.code = raw.code;
		items.push(item);
	}
	return items;
}

/**
 * One vault from `GET /vaults`. An entry without a usable id is dropped rather than repaired: it would
 * become the `vaultId` every local CRDT database is namespaced by, and a blank one silently commingles
 * two accounts' notes — which is the bug N2/F3 already cost us once.
 */
export function parseVault(x: unknown): Vault | null {
	if (!isRecord(x)) return null;
	if (typeof x.vaultId !== "string" || x.vaultId === "") return null;
	return {
		vaultId: x.vaultId,
		displayName: typeof x.displayName === "string" ? x.displayName : x.vaultId,
		createdAt: num(x.createdAt),
	};
}

/** The `vaults` array, malformed entries dropped. A non-array body yields none rather than throwing. */
export function parseVaults(body: unknown): Vault[] {
	if (!isRecord(body) || !Array.isArray(body.vaults)) return [];
	return body.vaults.map(parseVault).filter((v): v is Vault => v !== null);
}

/**
 * A WebSocket ticket pair.
 *
 * Throws rather than dropping, unlike the list parsers: there is no degraded mode here. A caller with
 * no ticket cannot open a socket, so failing loudly beats handing back `undefined` and letting
 * `new WebSocket(undefined)` be the error the user sees. The URL goes through the same host policy the
 * socket layer applies, so a redirected socket is refused at the boundary as well as at the sink.
 */
export function parseTicket(x: unknown): { ticket: string; url: string } {
	if (!isRecord(x) || typeof x.ticket !== "string" || x.ticket === "") {
		throw new Error("malformed ticket response: no ticket");
	}
	if (typeof x.url !== "string") throw new Error("malformed ticket response: no url");
	assertWssUrl(x.url);
	return { ticket: x.ticket, url: x.url };
}
