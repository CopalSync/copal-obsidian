import { describe, expect, it, vi } from "vitest";
import { PreconditionError, SyncApi } from "../../src/sync/api";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const bin = (bytes: number[], status = 200, headers: Record<string, string> = {}) =>
	new Response(new Uint8Array(bytes), { status, headers });
const makeApi = (f: typeof fetch, vaultId: string | undefined = "vlt_x") =>
	new SyncApi({
		f,
		getToken: () => Promise.resolve("tok"),
		getVaultId: () => vaultId,
	});

describe("SyncApi", () => {
	it("manifest() GETs /sync/changes?since=0 with a bearer", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				json({ head: 3, manifest: [{ path: "a.md", version: "v1", size: 1, mtime: 1 }] }),
			);
		const m = await makeApi(f).manifest();
		expect(m.head).toBe(3);
		expect(m.manifest[0]?.path).toBe("a.md");
		const [url, init] = f.mock.calls[0]!;
		expect(String(url)).toContain("/sync/changes?since=0");
		expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
	});

	it("manifest() pages through cursors and assembles the full list (head from page 1)", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				json({
					full: true,
					head: 9,
					manifest: [{ path: "a.md", version: "v1", size: 1, mtime: 1 }],
					cursor: "C1",
				}),
			)
			.mockResolvedValueOnce(
				json({
					full: true,
					head: 0,
					manifest: [{ path: "b.md", version: "v2", size: 1, mtime: 1 }],
				}),
			);
		const m = await makeApi(f).manifest();
		expect(m.head).toBe(9); // anchored to page 1, not the later page's 0
		expect(m.manifest.map((e) => e.path)).toEqual(["a.md", "b.md"]);
		expect(String(f.mock.calls[0]![0])).toContain("/sync/changes?since=0");
		expect(String(f.mock.calls[0]![0])).not.toContain("cursor");
		expect(String(f.mock.calls[1]![0])).toContain("cursor=C1");
		expect(f).toHaveBeenCalledTimes(2); // stops once the last page returns no cursor
	});

	it("manifest() drops malformed / unsafe-path entries (server-response validation)", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(
			json({
				head: 2,
				manifest: [
					{ path: "a.md", version: "v1", size: 1, mtime: 1 },
					{ path: "../evil.md", version: "v", size: 1, mtime: 1 }, // traversal → dropped
					{ path: 123, version: "v", size: 1, mtime: 1 }, // non-string → dropped
				],
			}),
		);
		const m = await makeApi(f).manifest();
		expect(m.manifest.map((e) => e.path)).toEqual(["a.md"]);
	});

	it("ticket() POSTs /sync/ticket", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json({ ticket: "tk", url: "wss://api.copal.uk/sync" }));
		const t = await makeApi(f).ticket();
		expect(t.ticket).toBe("tk");
		expect(f.mock.calls[0]![1]?.method).toBe("POST");
	});

	it("ycrdtTicket() POSTs /ycrdt/ticket", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json({ ticket: "yk", url: "wss://api.copal.uk/ycrdt" }));
		const t = await makeApi(f).ycrdtTicket();
		expect(t.ticket).toBe("yk");
		expect(String(f.mock.calls[0]![0])).toContain("/ycrdt/ticket");
		expect(f.mock.calls[0]![1]?.method).toBe("POST");
	});

	it("ycrdtSync() POSTs a page of base64 items and returns the per-item results", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(
			json({
				items: [
					{ path: "a.md", ok: true, update: "AAEC", sv: "AQ" },
					{ path: "b.md", ok: false, code: "GONE" },
				],
			}),
		);
		const items = await makeApi(f).ycrdtSync({
			device: "d1",
			items: [
				{ path: "a.md", sv: "AQ" },
				{ path: "b.md", sv: "AQ", update: "AAEC" },
			],
		});
		expect(String(f.mock.calls[0]![0])).toContain("/ycrdt/sync");
		expect(f.mock.calls[0]![1]?.method).toBe("POST");
		expect(JSON.parse(f.mock.calls[0]![1]!.body as string).items).toHaveLength(2);
		expect(items.map((i) => i.path)).toEqual(["a.md", "b.md"]);
		expect(items[0]?.update).toBe("AAEC");
		expect(items[1]?.code).toBe("GONE");
	});

	it("sends the X-Copal-Vault header when a vault is linked", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json({ head: 0, manifest: [] }));
		await makeApi(f, "vlt_abc").manifest();
		const headers = f.mock.calls[0]![1]!.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer tok");
		expect(headers["X-Copal-Vault"]).toBe("vlt_abc");
	});

	it("omits X-Copal-Vault when no vault is linked (server resolves the sole vault)", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json({ head: 0, manifest: [] }));
		await new SyncApi({ f, getToken: () => Promise.resolve("tok") }).manifest(); // no getVaultId → undefined
		const headers = f.mock.calls[0]![1]!.headers as Record<string, string>;
		expect(headers["X-Copal-Vault"]).toBeUndefined();
	});

	it("listVaults() GETs /vaults", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json({ vaults: [{ vaultId: "v1", displayName: "Work", createdAt: 0 }] }));
		const vaults = await makeApi(f).listVaults();
		expect(vaults[0]?.vaultId).toBe("v1");
		expect(String(f.mock.calls[0]![0])).toContain("/vaults");
	});

	it("createVault() POSTs /vaults with the name", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json({ vaultId: "v2", displayName: "CopalTest", createdAt: 0 }));
		const v = await makeApi(f).createVault("CopalTest");
		expect(v.vaultId).toBe("v2");
		const [url, init] = f.mock.calls[0]!;
		expect(String(url)).toContain("/vaults");
		expect(init!.method).toBe("POST");
		expect(JSON.parse(init!.body as string)).toEqual({ name: "CopalTest" });
	});

	it("moveNote() POSTs /vault/:from/move with the destination", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json({ from: "a.md", to: "b.md" }));
		await makeApi(f).moveNote("a.md", "b.md");
		const [url, init] = f.mock.calls[0]!;
		expect(String(url)).toContain("/vault/a.md/move");
		expect(init!.method).toBe("POST");
		expect(JSON.parse(init!.body as string)).toEqual({ to: "b.md" });
	});

	it("moveNote() encodes slashed paths and treats a 404 source as already-handled (no throw)", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 }));
		await expect(makeApi(f).moveNote("dir/a.md", "dir/b.md")).resolves.toBeUndefined();
		expect(String(f.mock.calls[0]![0])).toContain("/vault/dir/a.md/move");
	});

	it("moveNote() throws on a non-ok, non-404 response (e.g. 409 destination exists)", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 409 }));
		await expect(makeApi(f).moveNote("a.md", "b.md")).rejects.toThrow(/move failed/);
	});

	it("throws on a non-ok response", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 }));
		await expect(makeApi(f).manifest()).rejects.toThrow();
	});
});

describe("SyncApi binary files (E3)", () => {
	it("getFile GETs /file/:path and returns bytes + content-type + raw etag", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(bin([1, 2, 3, 255], 200, { "content-type": "image/png", ETag: '"e1"' }));
		const r = await makeApi(f).getFile("assets/b.png");
		expect(r).not.toBeNull();
		expect([...new Uint8Array(r!.bytes)]).toEqual([1, 2, 3, 255]);
		expect(r!.contentType).toBe("image/png");
		expect(r!.etag).toBe("e1"); // unquoted so it matches the manifest version
		expect(String(f.mock.calls[0]![0])).toContain("/file/assets/b.png");
	});

	it("getFile returns null on 404", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 }));
		expect(await makeApi(f).getFile("missing.png")).toBeNull();
	});

	it("putFile sends If-Match (quoted) + content-type and returns the new etag", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 201, headers: { ETag: '"e2"' } }));
		const r = await makeApi(f).putFile("a.png", new Uint8Array([9]).buffer, "image/png", "e1");
		expect(r.etag).toBe("e2");
		const init = f.mock.calls[0]![1]!;
		expect(init.method).toBe("PUT");
		const headers = init.headers as Record<string, string>;
		expect(headers["If-Match"]).toBe('"e1"');
		expect(headers["content-type"]).toBe("image/png");
	});

	it("putFile omits If-Match when no known etag is passed", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 201, headers: { ETag: '"e2"' } }));
		await makeApi(f).putFile("a.png", new Uint8Array([9]).buffer, "image/png");
		expect((f.mock.calls[0]![1]!.headers as Record<string, string>)["If-Match"]).toBeUndefined();
	});

	it("putFile throws PreconditionError carrying the server's current etag on 412", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 412, headers: { ETag: '"server"' } }));
		await expect(
			makeApi(f).putFile("a.png", new Uint8Array([9]).buffer, "image/png", "stale"),
		).rejects.toMatchObject({ name: "PreconditionError", currentEtag: "server" });
		expect(PreconditionError).toBeTruthy();
	});

	it("deleteFile DELETEs /file/:path and tolerates a 404", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 }));
		await expect(makeApi(f).deleteFile("dir/x.png")).resolves.toBeUndefined();
		expect(f.mock.calls[0]![1]!.method).toBe("DELETE");
		expect(String(f.mock.calls[0]![0])).toContain("/file/dir/x.png");
	});

	it("binary methods send the bearer + X-Copal-Vault header", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 201, headers: { ETag: '"e"' } }));
		await makeApi(f, "vlt_bin").putFile("a.png", new Uint8Array([1]).buffer, "image/png");
		const headers = f.mock.calls[0]![1]!.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer tok");
		expect(headers["X-Copal-Vault"]).toBe("vlt_bin");
	});
});

describe("SyncApi.search", () => {
	it("GETs /search with q + mode + limit and a bearer, returning validated hits", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json([{ path: "a.md", title: "A", snippet: "a bird" }]));
		const hits = await makeApi(f).search("bird of prey", { mode: "semantic", limit: 20 });
		expect(hits).toEqual([{ path: "a.md", title: "A", snippet: "a bird" }]);
		const [url, init] = f.mock.calls[0]!;
		const parsed = new URL(String(url));
		expect(parsed.pathname).toBe("/search");
		expect(parsed.searchParams.get("q")).toBe("bird of prey");
		expect(parsed.searchParams.get("mode")).toBe("semantic");
		expect(parsed.searchParams.get("limit")).toBe("20");
		expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
	});

	it("defaults to no mode param when unspecified (server default)", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json([]));
		await makeApi(f).search("x");
		expect(new URL(String(f.mock.calls[0]![0])).searchParams.has("mode")).toBe(false);
	});

	it("drops hits with an unsafe path defensively", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(
			json([
				{ path: "../evil", title: "x", snippet: "y" },
				{ path: "ok.md", title: "O", snippet: "k" },
			]),
		);
		expect((await makeApi(f).search("q")).map((h) => h.path)).toEqual(["ok.md"]);
	});

	it("throws on a non-ok response", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "boom" }, 500));
		await expect(makeApi(f).search("q")).rejects.toThrow();
	});
});

/**
 * S9. These five responses were `as`-cast straight into use: a server (or anything that could answer
 * as one) could return a vault with no id, a ticket that was not a string, or an attachment of any
 * size at all, and the plugin would carry on with it.
 */
describe("SyncApi: responses are parsed, not assumed", () => {
	it("drops a malformed vault rather than handing back a half one", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(
			json({
				vaults: [
					{ vaultId: "vlt_a", displayName: "Real", createdAt: 1 },
					{ displayName: "no id" },
					null,
					{ vaultId: "vlt_b", displayName: "Also real", createdAt: 2 },
				],
			}),
		);
		const vaults = await makeApi(f).listVaults();
		expect(vaults.map((v) => v.vaultId)).toEqual(["vlt_a", "vlt_b"]);
	});

	it("returns nothing when the vault list is not a list", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json({ vaults: "all of them" }));
		await expect(makeApi(f).listVaults()).resolves.toEqual([]);
	});

	it("refuses a ticket that is not a usable pair", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json({ ticket: 42, url: "wss://api.copal.uk/s" }));
		await expect(makeApi(f).ticket()).rejects.toThrow(/ticket/i);
	});

	it("refuses a ticket whose socket URL is not Copal's", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(json({ ticket: "t", url: "wss://api.copal.uk.evil.com/s" }));
		await expect(makeApi(f).ycrdtTicket()).rejects.toThrow(/untrusted url/i);
	});

	it("refuses an attachment larger than the cap, on the header, without reading it", async () => {
		const body = vi.fn();
		const res = new Response(new Uint8Array([1]), {
			status: 200,
			headers: { "content-length": String(101 * 1024 * 1024), etag: '"e"' },
		});
		Object.defineProperty(res, "arrayBuffer", { value: body });
		const f = vi.fn<typeof fetch>().mockResolvedValue(res);
		await expect(makeApi(f).getFile("big.bin")).rejects.toThrow(/too large/i);
		expect(body, "the oversized body was read anyway").not.toHaveBeenCalled();
	});

	it("refuses an attachment that exceeds the cap despite its header", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(
			bin(
				Array.from({ length: 64 }, () => 1),
				200,
				{ "content-length": "1" },
			),
		);
		const api = new SyncApi({
			f,
			getToken: () => Promise.resolve("tok"),
			getVaultId: () => "vlt_x",
			maxFileBytes: 32,
		});
		await expect(api.getFile("liar.bin")).rejects.toThrow(/too large/i);
	});
});
