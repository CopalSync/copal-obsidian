/**
 * `ObsidianVault` — the half of its behaviour the shared contract cannot express.
 *
 * `test/sync/vault-contract.test.ts` covers everything both `VaultWriter`s must share. What is here is
 * specific to the real adapter: which Obsidian method it reaches for, and the fact that its path
 * refusals are ASYMMETRIC by design — `read` throws, `write` and `remove` return silently. Those two
 * silent sinks are the ones most easily asserted vacuously, so each one checks that nothing happened
 * rather than that no error was raised.
 *
 * Before this file existed, `obsidian-vault.ts` had zero test references, and `resolve()` — the
 * `safePath` → `normalizePath` pairing that is the last line of defence before a filesystem sink — was
 * covered nowhere, despite `safePath` itself being well tested in isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/log";
import { ObsidianVault } from "../../src/sync/obsidian-vault";
import { stubApp, vaultOf } from "../stubs/obsidian";

// ⚠️ `log.warnOnce` remembers across calls BY DESIGN (a refused path would otherwise warn on every
// reconcile), and that memory is module-level — so without this an earlier test's paths silence a
// later test's assertions about them.
beforeEach(() => log.__resetOnce());

function subject(files: Record<string, string> = {}) {
	const app = stubApp(files);
	return { vault: new ObsidianVault(app), stub: vaultOf(app), app };
}

/** Every shape `safePath` rejects, one per reason it rejects it. */
const UNSAFE = [
	["traversal", "../escape.md"],
	["traversal mid-path", "notes/../../escape.md"],
	["absolute", "/etc/passwd.md"],
	["home-relative", "~/secrets.md"],
	["windows drive", "C:/Windows/evil.md"],
	["backslash", "notes\\escape.md"],
	["NUL byte", "bad\u0000name.md"],
	["newline", "bad\nname.md"],
	["DEL", "bad\u007fname.md"],
	["empty segment", "notes//note.md"],
	["dot segment", "notes/./note.md"],
	["config folder, other case", ".Obsidian/snippets.md"],
	["config folder, 8.3 alias", "OBSIDI~1/snippets.md"],
] as const;

describe("the path boundary", () => {
	it("write() refuses every unsafe shape SILENTLY, creating nothing", async () => {
		// ⚠️ `write` returns rather than throwing, so "it didn't throw" proves nothing. The assertion
		// has to be that the vault is still empty.
		const { vault, stub } = subject();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const [reason, path] of UNSAFE) {
			await vault.write(path, "should never land");
			expect(stub.snapshot(), `write must not create anything for ${reason}`).toEqual({});
			expect(stub.trashed, "and must not touch anything either").toEqual([]);
		}
		expect(warn, "each refusal is logged").toHaveBeenCalledTimes(UNSAFE.length);
		warn.mockRestore();
	});

	it("remove() refuses every unsafe shape SILENTLY, never reaching the vault", async () => {
		// ⚠️ Asserting only that nothing was trashed is VACUOUS here, and was: an unsafe path does not
		// exist, so `getAbstractFileByPath` returns null and nothing is trashed whether or not
		// `safePath` ran. Neutering `resolve()` left that version green. What distinguishes the two is
		// that a refused path must never be LOOKED UP at all — the refusal happens at the boundary.
		const { vault, stub, app } = subject({ "real.md": "keep me" });
		const lookup = vi.spyOn(app.vault, "getAbstractFileByPath");
		const trash = vi.spyOn(app.vault, "trash");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const [reason, path] of UNSAFE) {
			await vault.remove(path);
			expect(
				lookup,
				`${reason} must be refused before the vault is consulted`,
			).not.toHaveBeenCalled();
		}
		expect(trash).not.toHaveBeenCalled();
		expect(stub.trashed).toEqual([]);
		expect(stub.snapshot()["real.md"], "and the real file survives").toBe("keep me");
		expect(warn).toHaveBeenCalledTimes(UNSAFE.length);
		warn.mockRestore();
	});

	it("read() and readCached() THROW on every unsafe shape", async () => {
		const { vault } = subject();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const [reason, path] of UNSAFE) {
			await expect(
				Promise.resolve().then(() => vault.read(path)),
				`read must reject ${reason}`,
			).rejects.toThrow(/unsafe path/);
			await expect(Promise.resolve().then(() => vault.readCached(path))).rejects.toThrow(
				/unsafe path/,
			);
		}
		warn.mockRestore();
	});

	it("exists() answers false for an unsafe shape rather than consulting the vault", async () => {
		const { vault, app } = subject();
		const lookup = vi.spyOn(app.vault, "getAbstractFileByPath");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const [, path] of UNSAFE) expect(await vault.exists(path)).toBe(false);
		expect(lookup, "a refused path never reaches the vault at all").not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("refuses the vault's own config folder, whatever it has been renamed to (S1)", async () => {
		// `safePath` refuses every dot-prefixed segment, which covers `.obsidian`. `configDir` is the
		// authority on what the folder is called now, so the sink checks it too and does not rely on
		// the rename keeping a leading dot.
		const { vault, stub, app } = subject();
		app.vault.configDir = "settings";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const path of ["settings/snippets.md", "Settings/snippets.md", "SETTINGS./snippets.md"]) {
			await vault.write(path, "should never land");
			expect(await vault.exists(path), `${path} is refused before the vault is asked`).toBe(false);
			await expect(Promise.resolve().then(() => vault.read(path))).rejects.toThrow(/unsafe path/);
		}
		expect(stub.snapshot()).toEqual({});
		await vault.write("settings-notes/a.md", "a sibling folder is fine");
		expect(stub.snapshot()).toEqual({ "settings-notes/a.md": "a sibling folder is fine" });
		warn.mockRestore();
	});

	it("normalizePath alone would NOT be enough, which is why safePath runs first", async () => {
		// `normalizePath` collapses separators and strips a leading slash; it does not strip `..`.
		// This pins the reason the two are paired rather than one being redundant.
		const { vault, stub } = subject();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await vault.write("../../outside.md", "x");
		expect(Object.keys(stub.snapshot())).toEqual([]);
		warn.mockRestore();
	});

	it("still canonicalises a SAFE path through normalizePath", async () => {
		const { vault, stub } = subject();
		await vault.write("notes/ok.md", "x");
		expect(Object.keys(stub.snapshot())).toEqual(["notes/ok.md"]);
	});
});

describe("which Obsidian method it reaches for", () => {
	it("overwrites an existing note with process(), not create() or modify()", async () => {
		// ⛔ This is proved by construction rather than by spying. The double's `create()` REJECTS on an
		// existing path (as Obsidian's does) and its `modify()` REJECTS outright pointing at `process`.
		// So a write that lands on an existing file can only have gone through `process` — and if
		// someone swaps `process` for either of the others, this goes red.
		const { vault, stub } = subject({ "a.md": "before" });
		await vault.write("a.md", "after");
		expect(stub.snapshot()["a.md"]).toBe("after");
	});

	it("creates a new note with create(), after making its parent folders", async () => {
		const { vault, stub } = subject();
		await vault.write("a/b/c.md", "new");
		expect(stub.snapshot()["a/b/c.md"]).toBe("new");
		expect(stub.getFolderByPath("a"), "ensureFolder must have run").not.toBe(null);
		expect(stub.getFolderByPath("a/b")).not.toBe(null);
	});

	it("remove() goes to Obsidian's TRASH, never a hard delete", async () => {
		// A propagated remote delete must stay recoverable. `delete()` would be unrecoverable, and the
		// double keeps separate ledgers so the two cannot be confused.
		const { vault, stub } = subject({ "gone.md": "x" });
		await vault.remove("gone.md");
		expect(stub.trashed).toEqual(["gone.md"]);
		expect(stub.hardDeleted, "a hard unlink is not recoverable and must never happen").toEqual([]);
	});

	it("readCached() uses cachedRead, and read() uses read", async () => {
		// Not interchangeable: `readCached` is the per-edit read-at-dequeue path, so serving it from
		// Obsidian's cache instead of disk is the point.
		const { vault, app } = subject({ "a.md": "alpha" });
		const cached = vi.spyOn(app.vault, "cachedRead");
		const disk = vi.spyOn(app.vault, "read");

		expect(await vault.readCached("a.md")).toBe("alpha");
		expect(cached).toHaveBeenCalledTimes(1);
		expect(disk).not.toHaveBeenCalled();

		expect(await vault.read("a.md")).toBe("alpha");
		expect(disk).toHaveBeenCalledTimes(1);
	});

	it("list() asks for markdown files only", async () => {
		const { vault, stub, app } = subject({ "note.md": "x" });
		await stub.createBinary("pic.png", new ArrayBuffer(1));
		const markdown = vi.spyOn(app.vault, "getMarkdownFiles");
		const all = vi.spyOn(app.vault, "getFiles");
		expect(await vault.list()).toEqual(["note.md"]);
		expect(markdown).toHaveBeenCalled();
		expect(
			all,
			"getFiles() would include attachments, which get trashed on adopt",
		).not.toHaveBeenCalled();
	});
});

describe("the TFile branches", () => {
	it("read() rejects a folder, reaching the `instanceof TFile` guard", async () => {
		// ⛔ This guard is why the double needs TFile to be a real CLASS. It used to be a type alias,
		// erasing to `undefined`, so this line threw `Right-hand side of 'instanceof' is not an object`
		// — and nothing noticed, because no test could reach it.
		const { vault } = subject({ "dir/inner.md": "x" });
		await expect(Promise.resolve().then(() => vault.read("dir"))).rejects.toThrow(/not a file/);
	});

	it("write() treats an existing FOLDER at the path as not-a-file and tries to create", async () => {
		const { vault, stub } = subject({ "dir/inner.md": "x" });
		// `dir` is a folder, so the `existing instanceof TFile` branch is false and it falls through to
		// create() — which the double rejects, as Obsidian would for an occupied path.
		await expect(vault.write("dir", "x")).rejects.toThrow();
		expect(stub.snapshot()["dir/inner.md"], "the folder's contents are untouched").toBe("x");
	});
});

/**
 * ⛔ A server path Obsidian would fold onto a DIFFERENT note is refused, never written onto it.
 *
 * Obsidian's `normalizePath` maps U+00A0/U+202F to a space and composes to NFC. `resolve` used to hand
 * its result to the vault, so a server note `Meeting<NBSP>notes.md` became the user's own
 * `Meeting notes.md`: the bundle's text was written over it and pushed back into it on the server, and
 * a later delete of the variant trashed the user's real note.
 */
describe("a server path Obsidian would fold onto another note", () => {
	const VARIANTS = [
		["a no-break space", "Meeting notes.md", "Meeting notes.md"],
		["a narrow no-break space", "Meeting notes.md", "Meeting notes.md"],
		["a decomposed accent", "Café.md", "Café.md"],
		["the Kelvin sign", "Key ideas.md", "Key ideas.md"],
	] as const;

	it.each(VARIANTS)(
		"write() refuses %s rather than writing onto the user's note",
		async (_, variant, existing) => {
			const { vault, stub } = subject({ [existing]: "mine" });
			await expect(vault.write(variant, "theirs")).rejects.toThrow(/would store/);
			expect(stub.snapshot()).toEqual({ [existing]: "mine" });
		},
	);

	it.each(VARIANTS)(
		"remove() of %s never trashes the user's note",
		async (_, variant, existing) => {
			const { vault, stub } = subject({ [existing]: "mine" });
			await vault.remove(variant);
			expect(stub.trashed).toEqual([]);
			expect(stub.snapshot()).toEqual({ [existing]: "mine" });
		},
	);

	it.each(VARIANTS)(
		"exists() does not report %s as the user's note",
		async (_, variant, existing) => {
			const { vault } = subject({ [existing]: "mine" });
			expect(await vault.exists(variant)).toBe(false);
		},
	);
});
