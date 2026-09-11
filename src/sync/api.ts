/**
 * A failed call, carrying the status so the CALLER can decide what a person should read.
 *
 * ⛔ The status is not the message. It was briefly put straight into a Notice, which is a developer
 * artefact in a customer's face: "401" tells somebody with an expired session nothing they can act
 * on. It lives here so the UI can say "your session expired, sign in again" while the number stays
 * available for a log.
 */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		/** The gateway's machine-readable code, where it sends one. `VAULT_LIMIT_REACHED` is the only
		 *  error on POST /vaults that carries one, precisely so a client can say something specific. */
		readonly code?: string,
	) {
		super(`request failed: ${status}`);
		this.name = "ApiError";
	}
}

/** Read the gateway's error code without letting a non-JSON body become a second failure. */
async function errorCode(res: Response): Promise<string | undefined> {
	try {
		const body = (await res.json()) as { code?: unknown };
		return typeof body.code === "string" ? body.code : undefined;
	} catch {
		return undefined;
	}
}

import { API_BASE } from "../connect/oauth";
import { parseBatch, parseChangesResponse, parseManifest, parseSearch } from "./validate";

/** Safety cap on manifest pages (1000 pages × ~1000 objects = ~1M files) so a misbehaving server can't
 *  spin the paging loop forever. Far above any real vault. */
const MAX_MANIFEST_PAGES = 1000;

export interface ManifestEntry {
	path: string;
	version: string;
	size: number;
	mtime: number;
}

export interface Change {
	seq: number;
	path: string;
	op: "put" | "delete";
	version?: string;
	origin: string;
	ts: number;
	size?: number;
	mtime?: number;
}

export interface NoteContent {
	path: string;
	content: string;
	version?: string;
	mtime: number;
	size: number;
}

export interface Vault {
	vaultId: string;
	displayName: string;
	createdAt: number;
}

/** One search result from `GET /search` — no relevance score is exposed; order IS the ranking. */
export interface SearchHit {
	path: string;
	title: string;
	snippet: string;
}

/** Search mode: by-meaning (semantic), exact (keyword), or both fused (hybrid). */
export type SearchMode = "semantic" | "keyword" | "hybrid";

/** A binary attachment's bytes + metadata, as read from `GET /file`. `etag` is unquoted (matches the
 *  manifest `version`), so it round-trips as the `If-Match` token on the next `putFile`. */
export interface RemoteFile {
	bytes: ArrayBuffer;
	contentType: string;
	etag: string;
}

/** Thrown by `putFile` when the server rejects a conditional write (412) — the file changed since the
 *  caller's known etag. `currentEtag` is the server's version now (used to drive a last-writer-wins pull). */
export class PreconditionError extends Error {
	constructor(readonly currentEtag: string | undefined) {
		super("file changed since it was last read");
		this.name = "PreconditionError";
	}
}

/** Encode each path segment (preserving the `/` separators) for a URL, matching the note routes. */
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
/** Strip a weak-validator prefix + surrounding quotes from an ETag header → the raw etag. */
const unquoteEtag = (value: string): string => value.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

/**
 * Authenticated client for the Copal `/sync/*` surface. The `fetch` and a current-access-token getter
 * are injected so it's unit-testable (and so `main.ts` can supply the CORS-free `requestUrl` adapter).
 */
export class SyncApi {
	constructor(
		private readonly f: typeof fetch,
		private readonly getToken: () => Promise<string>,
		/** The Copal vault this Obsidian vault is linked to → sent as `X-Copal-Vault` so the tenant-scoped
		 *  token resolves the right vault. Absent ⇒ the account's sole vault (error if it has several). */
		private readonly getVaultId: () => Promise<string | undefined> = () =>
			Promise.resolve(undefined),
	) {}

	private async authed(path: string, init?: RequestInit): Promise<Response> {
		const token = await this.getToken();
		const vaultId = await this.getVaultId();
		return this.f(`${API_BASE}${path}`, {
			...init,
			headers: {
				...init?.headers,
				authorization: `Bearer ${token}`,
				...(vaultId ? { "X-Copal-Vault": vaultId } : {}),
			},
		});
	}

	/** The account's vaults — the connect-time "which vault?" list (each an isolated note namespace). */
	async listVaults(): Promise<Vault[]> {
		const res = await this.authed("/vaults");
		if (!res.ok) throw new ApiError(res.status);
		return ((await res.json()) as { vaults: Vault[] }).vaults;
	}

	/** Create a Copal vault (Obsidian-first sync-up names it after the folder). Plan-capped → throws on 403. */
	async createVault(name: string): Promise<Vault> {
		const res = await this.authed("/vaults", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name }),
		});
		if (!res.ok) throw new ApiError(res.status, await errorCode(res));
		return (await res.json()) as Vault;
	}

	/** Full manifest of the vault (every path + version) — the authoritative fresh/initial state. The server
	 *  pages it with a cursor, so loop until there's no `cursor`; that way a vault of ANY size fully syncs
	 *  (not just the first page). `head` anchors `lastSeq` to the snapshot start, so keep page 1's value. */
	async manifest(): Promise<{ head: number; manifest: ManifestEntry[] }> {
		const all: ManifestEntry[] = [];
		let head = 0;
		let cursor: string | undefined;
		let pages = 0;
		do {
			const query =
				cursor === undefined ? "since=0" : `since=0&cursor=${encodeURIComponent(cursor)}`;
			// oxlint-disable-next-line no-await-in-loop -- pages are inherently sequential (each needs the prior cursor)
			const res = await this.authed(`/sync/changes?${query}`);
			if (!res.ok) throw new Error(`manifest failed: ${res.status}`);
			// oxlint-disable-next-line no-await-in-loop
			const page = parseManifest(await res.json()); // validate + drop any unsafe (traversal) paths
			if (cursor === undefined) head = page.head; // page 1 anchors the cursor
			all.push(...page.manifest);
			cursor = page.cursor;
			pages += 1;
		} while (cursor !== undefined && pages < MAX_MANIFEST_PAGES);
		return { head, manifest: all };
	}

	/** Search the vault against the server-side index: `GET /search?q=&mode=&limit=`. `mode` defaults to the
	 *  server default (keyword) when omitted; the search pane sends `semantic` for by-meaning search. Returns
	 *  validated `{ path, title, snippet }` hits (unsafe paths dropped), server order preserved (= relevance). */
	async search(query: string, opts?: { mode?: SearchMode; limit?: number }): Promise<SearchHit[]> {
		const params = new URLSearchParams({ q: query });
		if (opts?.mode !== undefined) params.set("mode", opts.mode);
		if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
		// A mobile webview was serving a stale cached response (missing freshly-indexed notes). Defeat it on
		// every layer: a unique URL per request (cache-buster) + a no-cache request header (forces revalidation
		// even if a cache ignores the query). The server also sends `Cache-Control: no-store`.
		params.set("_", String(Date.now()));
		const res = await this.authed(`/search?${params.toString()}`, {
			headers: { "cache-control": "no-cache" },
		});
		if (!res.ok) throw new Error(`search failed: ${res.status}`);
		return parseSearch(await res.json());
	}

	/** The journal delta after `since`. */
	async changesSince(since: number): Promise<{ head: number; changes: Change[] }> {
		const res = await this.authed(`/sync/changes?since=${since}`);
		if (!res.ok) throw new Error(`changes failed: ${res.status}`);
		return parseChangesResponse(await res.json());
	}

	/** Mint a single-use WebSocket ticket. */
	async ticket(): Promise<{ ticket: string; url: string }> {
		const res = await this.authed("/sync/ticket", { method: "POST" });
		if (!res.ok) throw new Error(`ticket failed: ${res.status}`);
		return (await res.json()) as { ticket: string; url: string };
	}

	/** Mint a single-use ticket for a per-note CRDT WebSocket (`${url}/<path>?ticket=…`). */
	async ycrdtTicket(): Promise<{ ticket: string; url: string }> {
		const res = await this.authed("/ycrdt/ticket", { method: "POST" });
		if (!res.ok) throw new Error(`ycrdt ticket failed: ${res.status}`);
		return (await res.json()) as { ticket: string; url: string };
	}

	/** Propagate a local delete: `DELETE /vault/:path` removes R2, tears down the note's DO, and journals it. */
	async deleteNote(path: string): Promise<void> {
		const res = await this.authed(`/vault/${path.split("/").map(encodeURIComponent).join("/")}`, {
			method: "DELETE",
		});
		if (!res.ok && res.status !== 404) throw new Error(`delete failed: ${res.status}`);
	}

	/** History-preserving rename: `POST /vault/:from/move` transfers the note's CRDT log + R2 object to `to`
	 *  and tombstones the old path. A 404 (source not on the server yet) is swallowed — the caller's local
	 *  lineage transfer + upload-new still runs; any other non-ok (e.g. 409 destination exists) throws. */
	async moveNote(from: string, to: string): Promise<void> {
		const res = await this.authed(
			`/vault/${from.split("/").map(encodeURIComponent).join("/")}/move`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ to }),
			},
		);
		if (!res.ok && res.status !== 404) throw new Error(`move failed: ${res.status}`);
	}

	/** Read a binary attachment: `GET /file/:path` → raw bytes + content type + the R2 etag (unquoted).
	 *  A 404 (the file isn't on the server) resolves to `null`. */
	async getFile(path: string): Promise<RemoteFile | null> {
		const res = await this.authed(`/file/${encodePath(path)}`);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`get file failed: ${res.status}`);
		return {
			bytes: await res.arrayBuffer(),
			contentType: res.headers.get("content-type") ?? "application/octet-stream",
			etag: unquoteEtag(res.headers.get("ETag") ?? ""),
		};
	}

	/** Write a binary attachment: `PUT /file/:path` with the raw bytes. When `ifMatch` (a known etag) is
	 *  given it's sent as `If-Match` for R2-native optimistic concurrency; a **412** throws a
	 *  `PreconditionError` (carrying the server's current etag) so the caller can last-writer-wins pull.
	 *  Returns the new etag. */
	async putFile(
		path: string,
		bytes: ArrayBuffer,
		contentType: string,
		ifMatch?: string,
	): Promise<{ etag: string }> {
		const res = await this.authed(`/file/${encodePath(path)}`, {
			method: "PUT",
			headers: {
				"content-type": contentType,
				...(ifMatch === undefined ? {} : { "If-Match": `"${ifMatch}"` }),
			},
			body: bytes,
		});
		if (res.status === 412) {
			throw new PreconditionError(unquoteEtag(res.headers.get("ETag") ?? "") || undefined);
		}
		if (!res.ok) throw new Error(`put file failed: ${res.status}`);
		return { etag: unquoteEtag(res.headers.get("ETag") ?? "") };
	}

	/** Propagate a local delete: `DELETE /file/:path` removes the R2 object + journals it. A 404 is
	 *  swallowed (already gone). */
	async deleteFile(path: string): Promise<void> {
		const res = await this.authed(`/file/${encodePath(path)}`, { method: "DELETE" });
		if (!res.ok && res.status !== 404) throw new Error(`delete file failed: ${res.status}`);
	}

	/** Fetch the content of many notes in one round-trip; missing/errored paths are omitted. */
	async batchGet(paths: string[]): Promise<NoteContent[]> {
		const res = await this.authed("/sync/batch", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ get: paths }),
		});
		if (!res.ok) throw new Error(`batch failed: ${res.status}`);
		return parseBatch(await res.json()); // keep only found notes with a safe path + string content
	}
}
