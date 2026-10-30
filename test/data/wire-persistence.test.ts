import { describe, expect, it, vi } from "vitest";
import type { PersistedData } from "../../src/data/plugin-data-store";
import { wirePersistence } from "../../src/data/wire-persistence";
import { memCredentials } from "./fake-plugin-data";

/**
 * The five persisters, wired the way `main.ts` wires them.
 *
 * ⛔ **This code path had no test at all.** It lived inline in `onload()`, and the Obsidian stub's
 * `Plugin` is an empty class — so the thing that decided how five writers shared one file was the one
 * thing nothing could run. That is precisely the shape of the gap that let F2 and C14 through.
 *
 * ⚠️ What this still does NOT cover: that `main.ts` hands `wirePersistence` its own `loadData`/
 * `saveData`. Reaching `onload()` needs `registerEvent`, `addCommand`, `registerView`, `addSettingTab`,
 * `onLayoutReady` and `vault.on` on the stub — roadmap row G11, not this change. The source rule in
 * `store-rules.test.ts` is what holds that line in the meantime.
 */
/** What an older build wrote: the record plus the sign-in it kept there. */
type OnDisk = PersistedData & {
	tokens?: { access_token: string; refresh_token?: string };
	clientId?: string;
};

function fakeDisk(initial: OnDisk = {}) {
	let disk = JSON.parse(JSON.stringify(initial)) as OnDisk;
	const load = vi.fn(async (): Promise<unknown> => JSON.parse(JSON.stringify(disk)));
	const save = vi.fn(async (d: PersistedData): Promise<void> => {
		disk = JSON.parse(JSON.stringify(d)) as OnDisk;
	});
	return { io: { load, save }, load, save, peek: (): OnDisk => disk };
}

describe("wirePersistence", () => {
	it("reads data.json exactly once for all five persisters", async () => {
		const d = fakeDisk({
			vaultId: "vlt-1",
			sync: { lastSeq: 7, knownServer: ["a.md"] },
			pending: { deletes: ["gone.md"] },
			binary: { known: { "img.png": { etag: "e", hash: "h" } } },
			binaryPending: { deletes: ["old.png"] },
		});

		const p = await wirePersistence(d.io, memCredentials().credentials);

		expect(d.load, "five persisters used to mean five or more loads").toHaveBeenCalledOnce();
		// Each one loaded ITS key, not someone else's.
		expect(p.store.getVaultId()).toBe("vlt-1");
		expect(p.syncState.lastSeq).toBe(7);
		expect(p.syncState.knownServer).toEqual(["a.md"]);
		expect(p.mutationQueue.list()).toEqual(["gone.md"]);
		expect(p.binaryCursor.get("img.png")).toEqual({ etag: "e", hash: "h" });
		expect(p.binaryQueue.list()).toEqual(["old.png"]);
	});

	it("gives the two MutationQueues different keys, not the same one", async () => {
		const d = fakeDisk();
		const p = await wirePersistence(d.io, memCredentials().credentials);

		p.mutationQueue.enqueueDelete("note.md");
		p.binaryQueue.enqueueDelete("pic.png");
		await Promise.all([p.mutationQueue.persist(), p.binaryQueue.persist()]);

		expect(d.peek().pending?.deletes).toEqual(["note.md"]);
		expect(d.peek().binaryPending?.deletes).toEqual(["pic.png"]);
	});

	it("an unlink is not undone by a sync persister writing at the same time", async () => {
		const d = fakeDisk({ vaultId: "vlt-1", vaultName: "Work" });
		const p = await wirePersistence(d.io, memCredentials().credentials);

		// The real shape of the S3 bug: attachment sync is mid-flight when the folder is unlinked.
		p.binaryCursor.set("img.png", { etag: "e", hash: "h" });
		p.syncState.lastSeq = 42;
		await Promise.all([
			p.binaryCursor.persist(),
			p.store.unlinkVault(),
			p.syncState.persist(),
			p.mutationQueue.persist(),
		]);
		await p.data.flush();

		expect("vaultId" in d.peek(), "a concurrent persist resurrected the link").toBe(false);
		// And nobody's work was lost in the process.
		expect(d.peek().binary?.known["img.png"]?.etag).toBe("e");
		expect(d.peek().sync?.lastSeq).toBe(42);
	});

	it("four concurrent persists are not four rewrites of the whole record", async () => {
		const d = fakeDisk();
		const p = await wirePersistence(d.io, memCredentials().credentials);

		p.syncState.lastSeq = 1;
		p.mutationQueue.enqueueDelete("a.md");
		p.binaryCursor.set("b.png", { etag: "e", hash: "h" });
		p.binaryQueue.enqueueDelete("c.png");
		await Promise.all([
			p.syncState.persist(),
			p.mutationQueue.persist(),
			p.binaryCursor.persist(),
			p.binaryQueue.persist(),
		]);

		expect(d.save.mock.calls.length).toBeLessThanOrEqual(2);
		expect(d.peek().sync?.lastSeq).toBe(1);
		expect(d.peek().pending?.deletes).toEqual(["a.md"]);
		expect(d.peek().binary?.known["b.png"]?.etag).toBe("e");
		expect(d.peek().binaryPending?.deletes).toEqual(["c.png"]);
	});

	it("a persister mutating its own state does not reach the file until it persists", async () => {
		/*
		 * ⚠️ The `binary` key MUST already be on disk. With an empty record, `init()` takes the
		 * `?? {}` branch and builds a fresh object, so there is nothing to alias and this test passes
		 * without exercising the hazard at all — it did, until deleting the copy failed to break it.
		 */
		const d = fakeDisk({ binary: { known: { "old.png": { etag: "e0", hash: "h0" } } } });
		const p = await wirePersistence(d.io, memCredentials().credentials);

		p.binaryCursor.set("img.png", { etag: "e", hash: "h" });
		// Someone else writes. The cursor's uncommitted entry must NOT ride along: claiming a file is
		// synced before it was written makes last-writer-wins skip the pull forever.
		await p.store.setVault("vlt-1", "Work");

		expect(
			d.peek().binary?.known["img.png"],
			"persist() stopped being the commit point",
		).toBeUndefined();
		expect(d.peek().binary?.known["old.png"]?.etag).toBe("e0");

		await p.binaryCursor.persist();
		expect(d.peek().binary?.known["img.png"]?.etag).toBe("e");
	});

	it("a sign-in lands the tokens and their client together, and writes nothing to the file", async () => {
		// Apart, a refresh could present a client the tokens do not belong to.
		const d = fakeDisk({ vaultId: "vlt-1" });
		const { credentials } = memCredentials();
		const p = await wirePersistence(d.io, credentials);
		const before = d.save.mock.calls.length;

		await p.store.completeSignIn({ access_token: "at", refresh_token: "rt" }, "the-plugin");

		expect(credentials.signedIn()).toEqual({
			tokens: { access_token: "at", refresh_token: "rt" },
			clientId: "the-plugin",
		});
		expect(d.save.mock.calls.length - before, "the sign-in reached data.json").toBe(0);
	});

	it("⛔ queues an old build's sign-in for revocation, signs out, and takes it off the disk (NV33)", async () => {
		const d = fakeDisk({
			tokens: { access_token: "at", refresh_token: "DUMMY-RT" },
			clientId: "cid",
			vaultId: "vlt-1",
		});
		const { credentials } = memCredentials();
		const p = await wirePersistence(d.io, credentials);

		expect(p.foundExposedSignIn).toBe(true);
		expect(p.store.isConnected(), "a sign-in from the vault folder must not be used").toBe(false);
		expect(credentials.pendingRevokes()).toEqual([{ refresh_token: "DUMMY-RT", clientId: "cid" }]);
		expect(d.peek()).toEqual({ vaultId: "vlt-1" });
		// The folder's link is kept, so signing in again resumes the same vault.
		expect(p.store.getVaultId()).toBe("vlt-1");
	});

	it("⛔ an old build's sign-in with no refresh token has nothing to revoke, and is still dropped", async () => {
		const d = fakeDisk({ tokens: { access_token: "at" }, clientId: "cid" });
		const { credentials } = memCredentials();
		const p = await wirePersistence(d.io, credentials);
		expect(p.foundExposedSignIn).toBe(true);
		expect(credentials.pendingRevokes()).toEqual([]);
		expect(d.peek()).toEqual({});
	});

	it("⛔ a sign-in another device writes into the file is queued for revocation too", async () => {
		const d = fakeDisk({ vaultId: "v" });
		const { credentials } = memCredentials();
		const p = await wirePersistence(d.io, credentials);
		expect(p.foundExposedSignIn).toBe(false);

		await d.io.save({
			vaultId: "v",
			tokens: { access_token: "x", refresh_token: "THEIR-RT" },
			clientId: "cid",
		} as PersistedData);
		await p.data.reloadExternal();

		expect(credentials.pendingRevokes()).toEqual([{ refresh_token: "THEIR-RT", clientId: "cid" }]);
		expect(p.store.isConnected()).toBe(false);
		expect(d.peek()).toEqual({ vaultId: "v" });
	});

	it("a queue mutating its own list does not reach the file until it persists", async () => {
		const d = fakeDisk({ pending: { deletes: ["already.md"] } });
		const p = await wirePersistence(d.io, memCredentials().credentials);

		p.mutationQueue.enqueueDelete("new.md");
		await p.store.setVault("vlt-1", "Work");

		expect(d.peek().pending?.deletes).toEqual(["already.md"]);
		await p.mutationQueue.persist();
		expect(d.peek().pending?.deletes).toEqual(["already.md", "new.md"]);
	});
});
