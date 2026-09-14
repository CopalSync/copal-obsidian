import { describe, expect, it, vi } from "vitest";
import type { PersistedData } from "../../src/data/plugin-data-store";
import { wirePersistence } from "../../src/data/wire-persistence";

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
function fakeDisk(initial: PersistedData = {}) {
	let disk = JSON.parse(JSON.stringify(initial)) as PersistedData;
	const load = vi.fn(async (): Promise<unknown> => JSON.parse(JSON.stringify(disk)));
	const save = vi.fn(async (d: PersistedData): Promise<void> => {
		disk = JSON.parse(JSON.stringify(d)) as PersistedData;
	});
	return { io: { load, save }, load, save, peek: (): PersistedData => disk };
}

describe("wirePersistence", () => {
	it("reads data.json exactly once for all five persisters", async () => {
		const d = fakeDisk({
			tokens: { access_token: "at" },
			sync: { lastSeq: 7, knownServer: ["a.md"] },
			pending: { deletes: ["gone.md"] },
			binary: { known: { "img.png": { etag: "e", hash: "h" } } },
			binaryPending: { deletes: ["old.png"] },
		});

		const p = await wirePersistence(d.io);

		expect(d.load, "five persisters used to mean five or more loads").toHaveBeenCalledOnce();
		// Each one loaded ITS key, not someone else's.
		expect(p.store.getTokens()?.access_token).toBe("at");
		expect(p.syncState.lastSeq).toBe(7);
		expect(p.syncState.knownServer).toEqual(["a.md"]);
		expect(p.mutationQueue.list()).toEqual(["gone.md"]);
		expect(p.binaryCursor.get("img.png")).toEqual({ etag: "e", hash: "h" });
		expect(p.binaryQueue.list()).toEqual(["old.png"]);
	});

	it("gives the two MutationQueues different keys, not the same one", async () => {
		const d = fakeDisk();
		const p = await wirePersistence(d.io);

		p.mutationQueue.enqueueDelete("note.md");
		p.binaryQueue.enqueueDelete("pic.png");
		await Promise.all([p.mutationQueue.persist(), p.binaryQueue.persist()]);

		expect(d.peek().pending?.deletes).toEqual(["note.md"]);
		expect(d.peek().binaryPending?.deletes).toEqual(["pic.png"]);
	});

	it("a sign-out is not undone by a sync persister writing at the same time", async () => {
		const d = fakeDisk({ tokens: { access_token: "at", refresh_token: "rt" }, vaultId: "vlt-1" });
		const p = await wirePersistence(d.io);

		// The real shape of the S3 bug: attachment sync is mid-flight when the user signs out.
		p.binaryCursor.set("img.png", { etag: "e", hash: "h" });
		p.syncState.lastSeq = 42;
		await Promise.all([
			p.binaryCursor.persist(),
			p.store.signOut(),
			p.syncState.persist(),
			p.mutationQueue.persist(),
		]);
		await p.data.flush();

		expect(d.peek().tokens, "a concurrent persist resurrected the credential").toBeUndefined();
		expect("tokens" in d.peek()).toBe(false);
		// And nobody's work was lost in the process.
		expect(d.peek().binary?.known["img.png"]?.etag).toBe("e");
		expect(d.peek().sync?.lastSeq).toBe(42);
		expect(d.peek().vaultId).toBe("vlt-1");
	});

	it("four concurrent persists are not four rewrites of the whole record", async () => {
		const d = fakeDisk();
		const p = await wirePersistence(d.io);

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
		const p = await wirePersistence(d.io);

		p.binaryCursor.set("img.png", { etag: "e", hash: "h" });
		// Someone else writes. The cursor's uncommitted entry must NOT ride along: claiming a file is
		// synced before it was written makes last-writer-wins skip the pull forever.
		await p.store.setTokens({ access_token: "at" });

		expect(
			d.peek().binary?.known["img.png"],
			"persist() stopped being the commit point",
		).toBeUndefined();
		expect(d.peek().binary?.known["old.png"]?.etag).toBe("e0");

		await p.binaryCursor.persist();
		expect(d.peek().binary?.known["img.png"]?.etag).toBe("e");
	});

	it("starting a connect attempt is one write, not two", async () => {
		const d = fakeDisk({ clientId: "dead", clientScope: "old", connectAttemptPending: true });
		const p = await wirePersistence(d.io);
		const before = d.save.mock.calls.length;

		await p.store.beginConnectAttempt(true);

		expect(
			d.save.mock.calls.length - before,
			"discarding the registration and marking the attempt are one decision",
		).toBe(1);
		expect(d.peek().clientId).toBeUndefined();
		expect(d.peek().clientScope).toBeUndefined();
		expect(d.peek().connectAttemptPending).toBe(true);
	});

	it("keeps a registration it was not told to discard", async () => {
		const d = fakeDisk({ clientId: "good", clientScope: "s" });
		const p = await wirePersistence(d.io);

		await p.store.beginConnectAttempt(false);

		// The falsifier for the test above: a `beginConnectAttempt` that always cleared would pass it
		// while re-registering the client on every single connect.
		expect(d.peek().clientId).toBe("good");
		expect(d.peek().connectAttemptPending).toBe(true);
	});

	it("a queue mutating its own list does not reach the file until it persists", async () => {
		const d = fakeDisk({ pending: { deletes: ["already.md"] } });
		const p = await wirePersistence(d.io);

		p.mutationQueue.enqueueDelete("new.md");
		await p.store.setTokens({ access_token: "at" });

		expect(d.peek().pending?.deletes).toEqual(["already.md"]);
		await p.mutationQueue.persist();
		expect(d.peek().pending?.deletes).toEqual(["already.md", "new.md"]);
	});
});
