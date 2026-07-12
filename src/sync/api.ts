import { API_BASE } from "../connect/oauth";
import { parseBatch, parseChangesResponse, parseManifest } from "./validate";

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
    if (!res.ok) throw new Error(`list vaults failed: ${res.status}`);
    return ((await res.json()) as { vaults: Vault[] }).vaults;
  }

  /** Create a Copal vault (Obsidian-first sync-up names it after the folder). Plan-capped → throws on 403. */
  async createVault(name: string): Promise<Vault> {
    const res = await this.authed("/vaults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`create vault failed: ${res.status}`);
    return (await res.json()) as Vault;
  }

  /** Full manifest of the vault (all paths + versions) — the authoritative fresh/initial state. */
  async manifest(): Promise<{ head: number; manifest: ManifestEntry[] }> {
    const res = await this.authed("/sync/changes?since=0");
    if (!res.ok) throw new Error(`manifest failed: ${res.status}`);
    return parseManifest(await res.json()); // validate + drop any unsafe (traversal) paths
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
