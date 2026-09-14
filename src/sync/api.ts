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
		/** Which call failed, for the log line. Keeps the old `"<op> failed: <status>"` wording. */
		readonly op?: string,
	) {
		super(`${op ?? "request"} failed: ${status}`);
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
import {
	parseBatch,
	parseChangesResponse,
	parseManifest,
	parseSearch,
	parseTicket,
	parseVaults,
} from "./validate";

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
/**
 * Ceiling on a single attachment download. `arrayBuffer()` buffers the whole response in memory and on
 * a phone that is the process, so an unbounded one is a crash the server can trigger. 100 MiB clears
 * any attachment a vault plausibly holds while refusing something that is only trying to exhaust us.
 */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface SyncApiDeps {
	f: typeof fetch;
	getToken: () => Promise<string>;
	/** Override the download ceiling. Tests only — production wants {@link MAX_FILE_BYTES}. */
	maxFileBytes?: number;
	/** The Copal vault this Obsidian vault is linked to → sent as `X-Copal-Vault` so the tenant-scoped
	 *  token resolves the right vault. Absent ⇒ the account's sole vault (error if it has several). */
	getVaultId?: () => Promise<string | undefined>;
	/**
	 * A 401 came back. Refresh and return a token to retry with, or `null` to surface the 401.
	 *
	 * Kept as a callback rather than a `TokenManager` import so this client stays ignorant of OAuth.
	 */
	onUnauthorized?: (usedToken: string) => Promise<string | null>;
}

export class SyncApi {
	constructor(private readonly deps: SyncApiDeps) {}

	private async send(path: string, token: string, init?: RequestInit): Promise<Response> {
		const vaultId = await (this.deps.getVaultId?.() ?? Promise.resolve(undefined));
		return this.deps.f(`${API_BASE}${path}`, {
			...init,
			headers: {
				...init?.headers,
				authorization: `Bearer ${token}`,
				...(vaultId ? { "X-Copal-Vault": vaultId } : {}),
			},
		});
	}

	/**
	 * Send with the current bearer, and on a 401 refresh once and send again.
	 *
	 * ⛔ **THE REACTIVE PATH IS NOT REDUNDANT WITH THE PROACTIVE ONE.** There is zero clock tolerance
	 * anywhere in this stack (jose defaults `clockTolerance` to 0), phones sleep and wake with skewed
	 * clocks, and `expires_at` is absent entirely if a token response ever omits `expires_in`. Any of
	 * those leaves an expired token that looks fine locally and 401s at the edge.
	 *
	 * Retrying blindly is safe here for two reasons worth stating, because a future change could
	 * quietly break either. **(a)** The gateway's 401 comes from `makePrincipalAuth`, the FIRST
	 * middleware in the protected chain, so no handler has run and no side effect has happened — a
	 * retried `POST /vaults` or `DELETE /vault/:p` cannot double-apply. **(b)** Every body this
	 * client sends is a `string` or an `ArrayBuffer`, both re-sendable; a `ReadableStream` body added
	 * later would be consumed by the first attempt and silently send empty on the second.
	 *
	 * Exactly one retry: `refreshAfterUnauthorized` never recurses into this.
	 */
	private async authed(path: string, init?: RequestInit): Promise<Response> {
		const token = await this.deps.getToken();
		const res = await this.send(path, token, init);
		if (res.status !== 401 || !this.deps.onUnauthorized) return res;

		const refreshed = await this.deps.onUnauthorized(token);
		if (refreshed === null) return res;
		return this.send(path, refreshed, init);
	}

	/** The account's vaults — the connect-time "which vault?" list (each an isolated note namespace). */
	async listVaults(): Promise<Vault[]> {
		const res = await this.authed("/vaults");
		if (!res.ok) throw new ApiError(res.status);
		return parseVaults(await res.json());
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
			if (!res.ok) throw new ApiError(res.status, undefined, "manifest");
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
		if (!res.ok) throw new ApiError(res.status, undefined, "search");
		return parseSearch(await res.json());
	}

	/** The journal delta after `since`. */
	async changesSince(since: number): Promise<{ head: number; changes: Change[] }> {
		const res = await this.authed(`/sync/changes?since=${since}`);
		if (!res.ok) throw new ApiError(res.status, undefined, "changes");
		return parseChangesResponse(await res.json());
	}

	/** Mint a single-use WebSocket ticket. */
	async ticket(): Promise<{ ticket: string; url: string }> {
		const res = await this.authed("/sync/ticket", { method: "POST" });
		if (!res.ok) throw new ApiError(res.status, undefined, "ticket");
		return parseTicket(await res.json());
	}

	/** Mint a single-use ticket for a per-note CRDT WebSocket (`${url}/<path>?ticket=…`). */
	async ycrdtTicket(): Promise<{ ticket: string; url: string }> {
		const res = await this.authed("/ycrdt/ticket", { method: "POST" });
		if (!res.ok) throw new ApiError(res.status, undefined, "ycrdt ticket");
		return parseTicket(await res.json());
	}

	/** Propagate a local delete: `DELETE /vault/:path` removes R2, tears down the note's DO, and journals it. */
	async deleteNote(path: string): Promise<void> {
		const res = await this.authed(`/vault/${path.split("/").map(encodeURIComponent).join("/")}`, {
			method: "DELETE",
		});
		if (!res.ok && res.status !== 404) throw new ApiError(res.status, undefined, "delete");
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
		if (!res.ok && res.status !== 404) throw new ApiError(res.status, undefined, "move");
	}

	/** Read a binary attachment: `GET /file/:path` → raw bytes + content type + the R2 etag (unquoted).
	 *  A 404 (the file isn't on the server) resolves to `null`. */
	async getFile(path: string): Promise<RemoteFile | null> {
		const res = await this.authed(`/file/${encodePath(path)}`);
		if (res.status === 404) return null;
		if (!res.ok) throw new ApiError(res.status, undefined, "get file");
		/*
		 * A download had no ceiling at all: `arrayBuffer()` buffers the WHOLE response in memory, and on
		 * a phone that is the process. The header is checked first because refusing there is the only
		 * check that costs nothing — by the time the body has been read the memory is already spent.
		 * The second check is for a header that lied, which is cheap insurance rather than protection.
		 */
		const cap = this.deps.maxFileBytes ?? MAX_FILE_BYTES;
		const declared = Number(res.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > cap) {
			throw new ApiError(res.status, undefined, `file too large (${declared} bytes)`);
		}
		const bytes = await res.arrayBuffer();
		if (bytes.byteLength > cap) {
			throw new ApiError(res.status, undefined, `file too large (${bytes.byteLength} bytes)`);
		}
		return {
			bytes,
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
		if (!res.ok) throw new ApiError(res.status, undefined, "put file");
		return { etag: unquoteEtag(res.headers.get("ETag") ?? "") };
	}

	/** Propagate a local delete: `DELETE /file/:path` removes the R2 object + journals it. A 404 is
	 *  swallowed (already gone). */
	async deleteFile(path: string): Promise<void> {
		const res = await this.authed(`/file/${encodePath(path)}`, { method: "DELETE" });
		if (!res.ok && res.status !== 404) throw new ApiError(res.status, undefined, "delete file");
	}

	/** Fetch the content of many notes in one round-trip; missing/errored paths are omitted. */
	async batchGet(paths: string[]): Promise<NoteContent[]> {
		const res = await this.authed("/sync/batch", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ get: paths }),
		});
		if (!res.ok) throw new ApiError(res.status, undefined, "batch");
		return parseBatch(await res.json()); // keep only found notes with a safe path + string content
	}
}
