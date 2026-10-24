import { describe, expect, it, vi } from "vitest";
import { PreconditionError, type SyncApi } from "../../src/sync/api";
import { BinaryCursor } from "../../src/sync/binary-cursor";
import { BinarySync, isAttachmentPath } from "../../src/sync/binary-sync";
import { fnv1a } from "../../src/sync/fnv";
import { MutationQueue } from "../../src/sync/mutation-queue";
import { memSlice } from "../data/fake-plugin-data";
import { InMemoryBinaryVault } from "./fake-binary-vault";

describe("isAttachmentPath", () => {
	it("accepts a normal non-.md file", () => {
		expect(isAttachmentPath("assets/diagram.png")).toBe(true);
	});
	it("rejects .md, .obsidian config, and trash", () => {
		expect(isAttachmentPath("note.md")).toBe(false);
		expect(isAttachmentPath(".obsidian/app.json")).toBe(false);
		expect(isAttachmentPath(".trash/old.png")).toBe(false);
	});
	it("rejects the config folder in any case, and by its 8.3 short name (S1)", () => {
		// The exact-case `.obsidian/` prefix this replaced let `.Obsidian/plugins/copal/main.js` through,
		// and on a case-insensitive filesystem that path IS this plugin's own code.
		expect(isAttachmentPath(".Obsidian/plugins/copal/main.js")).toBe(false);
		expect(isAttachmentPath(".OBSIDIAN/plugins/copal/main.js")).toBe(false);
		expect(isAttachmentPath("OBSIDI~1/plugins/copal/main.js")).toBe(false);
		expect(isAttachmentPath(".Trash/old.png")).toBe(false);
	});
	it("rejects a name with control characters (unroutable over HTTP → would 404-loop)", () => {
		expect(isAttachmentPath("photo (@x)\n18 likes.png")).toBe(false);
	});
});

const buf = (arr: number[]) => new Uint8Array(arr).buffer;

/** A fake `/file` server with R2-style etag CAS, so a `putFile` with a stale `ifMatch` throws. */
function fakeApi() {
	const server = new Map<string, { bytes: ArrayBuffer; etag: string; contentType: string }>();
	let seq = 0;
	return {
		server,
		getFile: vi.fn((path: string) => {
			const f = server.get(path);
			return Promise.resolve(
				f ? { bytes: f.bytes, contentType: f.contentType, etag: f.etag } : null,
			);
		}),
		putFile: vi.fn((path: string, bytes: ArrayBuffer, contentType: string, ifMatch?: string) => {
			const existing = server.get(path);
			if (ifMatch !== undefined && existing?.etag !== ifMatch) {
				return Promise.reject(new PreconditionError(existing?.etag));
			}
			const etag = `srv-${(seq += 1)}`;
			server.set(path, { bytes, etag, contentType });
			return Promise.resolve({ etag });
		}),
		deleteFile: vi.fn((path: string) => {
			server.delete(path);
			return Promise.resolve();
		}),
	};
}

async function inMemoryQueue(): Promise<MutationQueue> {
	const q = new MutationQueue((await memSlice("binaryPending")).slice);
	q.init();
	return q;
}

async function inMemoryCursor(): Promise<BinaryCursor> {
	const c = new BinaryCursor((await memSlice("binary")).slice);
	c.init();
	return c;
}

async function build(opts: { local?: Record<string, number[]> } = {}) {
	const files = new InMemoryBinaryVault(opts.local ?? {});
	const api = fakeApi();
	const cursor = await inMemoryCursor();
	const queue = await inMemoryQueue();
	const sync = new BinarySync({
		api: api as unknown as Pick<SyncApi, "getFile" | "putFile" | "deleteFile">,
		files,
		cursor,
		queue,
	});
	return { sync, api, files, cursor, queue };
}

describe("BinarySync", () => {
	it("pull writes the server bytes and records the etag cursor", async () => {
		const { sync, api, files, cursor } = await build();
		api.server.set("a.png", { bytes: buf([1, 2, 3]), etag: "e1", contentType: "image/png" });
		await sync.pull("a.png");
		expect(files.bytes("a.png")).toEqual([1, 2, 3]);
		expect(cursor.get("a.png")?.etag).toBe("e1");
	});

	it("pushLocal PUTs a new local file with no If-Match and records the new etag", async () => {
		const { sync, api, cursor } = await build({ local: { "a.png": [9] } });
		await sync.pushLocal("a.png");
		expect(api.putFile).toHaveBeenCalledWith("a.png", expect.anything(), "image/png", undefined);
		expect(cursor.get("a.png")?.etag).toBe("srv-1");
	});

	it("pushLocal skips a file whose content is unchanged since the last sync (echo suppression)", async () => {
		const { sync, api } = await build({ local: { "a.png": [9] } });
		await sync.pushLocal("a.png"); // first push records the cursor
		api.putFile.mockClear();
		await sync.pushLocal("a.png"); // identical bytes → no-op
		expect(api.putFile).not.toHaveBeenCalled();
	});

	it("pushLocal on a 412 keeps a conflict copy and last-writer-wins-pulls the server version", async () => {
		const { sync, api, files, cursor } = await build({ local: { "a.png": [9] } });
		cursor.set("a.png", { etag: "stale", hash: "00000000" }); // we think the server is at "stale"
		api.server.set("a.png", { bytes: buf([7, 7]), etag: "srv-cur", contentType: "image/png" });
		await sync.pushLocal("a.png");
		// The copy carries a time + device stamp (S8), so it is found by shape rather than by a literal.
		const copy = files
			.paths()
			.find((p) => p.startsWith("a (conflicted copy ") && p.endsWith(".png"));
		expect(copy, "no stamped conflict copy was kept").toBeDefined();
		expect(files.bytes(copy!)).toEqual([9]); // local kept (name split at the extension)
		expect(files.bytes("a.png")).toEqual([7, 7]); // server won in place
		expect(cursor.get("a.png")?.etag).toBe("srv-cur");
	});

	it("deleteLocal removes the file server-side and drops the cursor on success", async () => {
		const { sync, api, cursor } = await build();
		cursor.set("a.png", { etag: "e", hash: "h" });
		await sync.deleteLocal("a.png");
		expect(api.deleteFile).toHaveBeenCalledWith("a.png");
		expect(cursor.get("a.png")).toBeUndefined();
	});

	it("deleteLocal durably queues the intent and rethrows when the server delete fails", async () => {
		const { sync, api, queue } = await build();
		api.deleteFile.mockRejectedValueOnce(new Error("offline"));
		await expect(sync.deleteLocal("a.png")).rejects.toThrow("offline");
		expect(queue.list()).toContain("a.png");
	});

	it("onRemoteChange delete trashes the local file and drops the cursor", async () => {
		const { sync, files, cursor } = await build({ local: { "a.png": [1] } });
		cursor.set("a.png", { etag: "e", hash: "h" });
		await sync.onRemoteChange({ path: "a.png", op: "delete" });
		expect(files.trashed).toContain("a.png");
		expect(cursor.get("a.png")).toBeUndefined();
	});

	it("onRemoteChange put skips the pull when the change is our own echo (etag already known)", async () => {
		const { sync, api, cursor } = await build();
		cursor.set("a.png", { etag: "srv-9", hash: "h" });
		await sync.onRemoteChange({ path: "a.png", op: "put", version: "srv-9" });
		expect(api.getFile).not.toHaveBeenCalled();
	});

	it("onRemoteChange put pulls when the etag differs (a genuine remote write)", async () => {
		const { sync, api, files, cursor } = await build();
		cursor.set("a.png", { etag: "srv-old", hash: "h" });
		api.server.set("a.png", { bytes: buf([5, 5]), etag: "srv-new", contentType: "image/png" });
		await sync.onRemoteChange({ path: "a.png", op: "put", version: "srv-new" });
		expect(files.bytes("a.png")).toEqual([5, 5]);
		expect(cursor.get("a.png")?.etag).toBe("srv-new");
	});

	describe("reconcile", () => {
		it("merge: pulls a new remote file, pushes a new local file, trashes a known-then-remotely-deleted file", async () => {
			const { sync, api, files, cursor } = await build({
				local: { "local-new.png": [2], "gone.png": [3] },
			});
			api.server.set("remote-new.png", { bytes: buf([1]), etag: "r1", contentType: "image/png" });
			// gone.png was previously synced (known) but is no longer on the server → a remote delete.
			cursor.set("gone.png", { etag: "g1", hash: fnv1a(new Uint8Array([3])) });

			await sync.reconcile([{ path: "remote-new.png", version: "r1" }], "merge");

			expect(files.bytes("remote-new.png")).toEqual([1]); // pulled
			expect(api.putFile).toHaveBeenCalledWith(
				"local-new.png",
				expect.anything(),
				"image/png",
				undefined,
			); // pushed
			expect(files.trashed).toContain("gone.png"); // trashed (remote delete)
		});

		it("adopt: pulls every server file and trashes every local-only file, pushing nothing", async () => {
			const { sync, api, files } = await build({ local: { "cruft.png": [9] } });
			api.server.set("keep.png", { bytes: buf([1]), etag: "k1", contentType: "image/png" });
			await sync.reconcile([{ path: "keep.png", version: "k1" }], "adopt");
			expect(files.bytes("keep.png")).toEqual([1]);
			expect(files.trashed).toContain("cruft.png");
			expect(api.putFile).not.toHaveBeenCalled();
		});
	});
});

describe("P4 — the stat gate", () => {
	it("skips the read and hash entirely when neither side has moved", async () => {
		// ⛔ The whole point of P4. This used to read and FNV-hash EVERY attachment on EVERY reconcile, on
		// the main thread. In the steady state — which is most reconciles — nothing has changed on either
		// side, and `TFile.stat` says so for free.
		const { sync, api, files, cursor } = await build({ local: { "a.png": [1, 2, 3] } });
		api.server.set("a.png", { bytes: buf([1, 2, 3]), etag: "e1", contentType: "image/png" });
		await sync.pushLocal("a.png"); // establishes the cursor, including size + mtime
		const serverEtag = cursor.get("a.png")?.etag;
		expect(serverEtag).toBeDefined();

		const readsBefore = files.reads;
		await sync.reconcile([{ path: "a.png", version: serverEtag as string }], "merge");
		expect(files.reads - readsBefore, "an unchanged attachment must not be read").toBe(0);
	});

	it("reads when the local file has changed", async () => {
		const { sync, api, files, cursor } = await build({ local: { "a.png": [1, 2, 3] } });
		api.server.set("a.png", { bytes: buf([1, 2, 3]), etag: "e1", contentType: "image/png" });
		await sync.pushLocal("a.png");
		const serverEtag = cursor.get("a.png")?.etag as string;

		await files.writeBinary("a.png", buf([9, 9, 9, 9])); // a genuine local edit
		const readsBefore = files.reads;
		await sync.reconcile([{ path: "a.png", version: serverEtag }], "merge");
		expect(files.reads - readsBefore, "a changed attachment must be read").toBeGreaterThan(0);
	});

	it("reads when only the mtime moved, even at the same size", async () => {
		// Same length, different content is the case a size-only gate would miss.
		const { sync, api, files, cursor } = await build({ local: { "a.png": [1, 2, 3] } });
		api.server.set("a.png", { bytes: buf([1, 2, 3]), etag: "e1", contentType: "image/png" });
		await sync.pushLocal("a.png");
		const serverEtag = cursor.get("a.png")?.etag as string;

		files.__touch("a.png");
		const readsBefore = files.reads;
		await sync.reconcile([{ path: "a.png", version: serverEtag }], "merge");
		expect(files.reads - readsBefore).toBeGreaterThan(0);
	});

	it("reads when the SERVER etag moved, even if the local stat is unchanged", async () => {
		const { sync, api, files, cursor } = await build({ local: { "a.png": [1, 2, 3] } });
		api.server.set("a.png", { bytes: buf([1, 2, 3]), etag: "e1", contentType: "image/png" });
		await sync.pushLocal("a.png");
		void cursor;
		const readsBefore = files.reads;
		await sync.reconcile([{ path: "a.png", version: "a-different-etag" }], "merge");
		expect(files.reads - readsBefore, "the server changing is a reason to look").toBeGreaterThan(0);
	});

	it("reads when the cursor predates P4 and has no recorded size", async () => {
		// ⚠️ Conservative on purpose: a missing size means UNKNOWN, never "unchanged". A cursor written by
		// an older build must not be read as proof that nothing happened.
		const { sync, api, files, cursor } = await build({ local: { "a.png": [1, 2, 3] } });
		api.server.set("a.png", { bytes: buf([1, 2, 3]), etag: "e1", contentType: "image/png" });
		cursor.set("a.png", { etag: "e1", hash: fnv1a(new Uint8Array([1, 2, 3])) }); // no size/mtime
		const readsBefore = files.reads;
		await sync.reconcile([{ path: "a.png", version: "e1" }], "merge");
		expect(files.reads - readsBefore).toBeGreaterThan(0);
	});

	it("records the stat AFTER writing, so the next gate compares the right mtime", async () => {
		// Taking the stat before the write would record the pre-write mtime, and the very next reconcile
		// would then think the file had changed — the gate would never fire.
		const { sync, api, files, cursor } = await build();
		api.server.set("a.png", { bytes: buf([7, 7]), etag: "e9", contentType: "image/png" });
		await sync.pull("a.png");
		const recorded = cursor.get("a.png");
		const actual = await files.stat("a.png");
		expect(recorded?.size).toBe(actual?.size);
		expect(recorded?.mtime).toBe(actual?.mtime);
	});
});

describe("P4 — the size ceiling", () => {
	const HUGE = 100 * 1024 * 1024;

	it("refuses to push an attachment at or over 100 MB, without reading it", async () => {
		// ⚠️ The ceiling is about MEMORY: putFile buffers the whole body, and on a phone that allocation
		// is the process. So the size is checked BEFORE the read, not after.
		const { sync, api, files } = await build();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(files, "stat").mockResolvedValue({ size: HUGE, mtime: 1 });
		const readsBefore = files.reads;

		await sync.pushLocal("huge.mp4");
		expect(files.reads - readsBefore, "it must not allocate the buffer").toBe(0);
		expect(api.putFile).not.toHaveBeenCalled();
		expect(warn.mock.calls.flat().join(" "), "a silent skip looks like data loss").toMatch(
			/skipping attachment over the 100 MB limit/,
		);
		warn.mockRestore();
	});

	it("says the file stays in the vault, so the warning is not alarming", async () => {
		const { sync, files } = await build();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(files, "stat").mockResolvedValue({ size: HUGE, mtime: 1 });
		await sync.pushLocal("huge.mp4");
		expect(warn.mock.calls.flat().join(" ")).toMatch(/stays in your vault but will not sync/);
		warn.mockRestore();
	});

	it("warns once per path, not once per reconcile", async () => {
		const { sync, files } = await build();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(files, "stat").mockResolvedValue({ size: HUGE, mtime: 1 });
		await sync.pushLocal("huge.mp4");
		await sync.pushLocal("huge.mp4");
		await sync.pushLocal("huge.mp4");
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("still syncs a file just under the ceiling", async () => {
		const { sync, api, files } = await build({ local: { "ok.png": [1, 2] } });
		vi.spyOn(files, "stat").mockResolvedValue({ size: HUGE - 1, mtime: 1 });
		await sync.pushLocal("ok.png");
		expect(api.putFile).toHaveBeenCalledOnce();
	});
});
