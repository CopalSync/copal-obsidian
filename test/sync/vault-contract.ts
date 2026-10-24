/**
 * One contract, every `VaultWriter`.
 *
 * `src/sync/vault.ts` has two implementations: `InMemoryVault`, which nine test files use to drive the
 * sync engine, and `ObsidianVault`, which is what actually runs. Testing them separately is how they
 * drift, and a fake that is MORE PERMISSIVE than production is the worst kind: every engine test keeps
 * passing while exercising a world the real adapter would have refused.
 *
 * ⚠️ Not every case can live here. `ObsidianVault` has asymmetries the fake has no counterpart for —
 * `write` on a refused path returns silently while `read` throws, and `remove` must reach Obsidian's
 * TRASH rather than a hard unlink. Those are asserted in `test/sync/obsidian-vault.test.ts` against the
 * real adapter. What belongs here is behaviour both are REQUIRED to share.
 *
 * ⛔ This file is deliberately not a `*.test.ts`: `scripts/assert-suites-ran.mjs` counts test files
 * against what vitest reports, and a shared `describe` factory is not a suite of its own.
 */
import { expect, it } from "vitest";
import type { VaultWriter } from "../../src/sync/vault";

/** What a contract run needs: the subject, a way to arrange files, and a way to read the result. */
export interface VaultUnderTest {
	vault: VaultWriter;
	/** Put a file there without going through the subject, so arrange and act stay separable. */
	seed(path: string, content: string): void;
	/** Every text file currently present, keyed by path. */
	snapshot(): Record<string, string>;
}

/**
 * Both implementations signal "cannot read that" by THROWING SYNCHRONOUSLY — `ObsidianVault.read` is
 * not `async`, so the throw in `readWith` escapes before a promise exists. Normalise, so the contract
 * asserts the observable outcome (the call fails) rather than pinning an implementation detail that
 * neither caller depends on.
 */
async function expectFails(call: () => unknown): Promise<void> {
	await expect(Promise.resolve().then(call)).rejects.toThrow();
}

/** Every behaviour a `VaultWriter` must have, whatever is behind it. */
export function describeVaultWriterContract(make: () => VaultUnderTest): void {
	it("exists() is true for a present file and false for an absent one", async () => {
		const t = make();
		t.seed("a.md", "alpha");
		expect(await t.vault.exists("a.md")).toBe(true);
		expect(await t.vault.exists("missing.md")).toBe(false);
	});

	it("write() then read() round-trips the content", async () => {
		const t = make();
		await t.vault.write("new.md", "written");
		expect(await t.vault.read("new.md")).toBe("written");
		expect(t.snapshot()["new.md"]).toBe("written");
	});

	it("write() overwrites an existing file in place", async () => {
		const t = make();
		t.seed("a.md", "before");
		await t.vault.write("a.md", "after");
		expect(await t.vault.read("a.md")).toBe("after");
	});

	it("write() creates missing ancestor folders", async () => {
		const t = make();
		await t.vault.write("deep/nested/note.md", "x");
		expect(await t.vault.read("deep/nested/note.md")).toBe("x");
	});

	it("readCached() returns the same content as read()", async () => {
		const t = make();
		t.seed("a.md", "alpha");
		expect(await t.vault.readCached("a.md")).toBe(await t.vault.read("a.md"));
	});

	it("read() fails on a path that is not there", async () => {
		const t = make();
		await expectFails(() => t.vault.read("missing.md"));
	});

	it("read() fails on a folder rather than returning something", async () => {
		const t = make();
		t.seed("dir/inner.md", "x");
		await expectFails(() => t.vault.read("dir"));
	});

	it("remove() deletes the file, and is a no-op on an absent path", async () => {
		const t = make();
		t.seed("a.md", "alpha");
		await t.vault.remove("a.md");
		expect(await t.vault.exists("a.md")).toBe(false);
		await t.vault.remove("a.md"); // must not throw
		await t.vault.remove("never-existed.md");
	});

	it("list() returns markdown notes", async () => {
		const t = make();
		t.seed("a.md", "alpha");
		t.seed("sub/b.md", "bravo");
		expect([...(await t.vault.list())].sort()).toEqual(["a.md", "sub/b.md"]);
	});

	it("list() EXCLUDES attachments", async () => {
		// ⛔ Load-bearing, not tidiness. `src/crdt/crdt-sync.ts` folds `vault.list()` into `local`,
		// derives `toRemove` from it, and sends each one to `vault.remove()` → Obsidian's TRASH. On an
		// ADOPT reconcile every local path absent from the server manifest is removed — and the manifest
		// partition for attachments is a SEPARATE channel. So an attachment appearing here would be
		// trashed on adopt. `src/sync/vault.ts:7` documents list() as markdown-only and
		// crdt-sync.ts:701 relies on it by name; this is what holds that invariant.
		const t = make();
		t.seed("note.md", "text");
		t.seed("pic.png", "bytes");
		t.seed("doc.pdf", "bytes");
		expect(await t.vault.list()).toEqual(["note.md"]);
	});

	it("refuses a traversal path instead of writing outside the vault", async () => {
		// Both implementations must fail closed. `ObsidianVault` validates with `safePath` before every
		// filesystem sink; a fake without that policy is a more permissive world than production, so
		// every engine test above it would be running against rules the real adapter does not have.
		const t = make();
		for (const bad of ["../escape.md", "/abs.md", "a/../../b.md", "~/home.md", "C:/win.md"]) {
			await t.vault.write(bad, "should not land");
			expect(
				Object.keys(t.snapshot()),
				`writing ${JSON.stringify(bad)} must not create anything`,
			).toEqual([]);
		}
	});

	it("refuses a path with a control character", async () => {
		// A single file with a control character in its name once put the client into a /ycrdt
		// reconnect loop and broke sync for a whole vault.
		const t = make();
		await t.vault.write("bad\u0000name.md", "x");
		await t.vault.write("bad\nname.md", "x");
		expect(Object.keys(t.snapshot())).toEqual([]);
	});

	it("a refused path is not reported as existing, and removing it is a no-op", async () => {
		const t = make();
		expect(await t.vault.exists("../escape.md")).toBe(false);
		await t.vault.remove("../escape.md"); // must not throw
	});
}
