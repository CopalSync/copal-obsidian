/**
 * The double, under test.
 *
 * `test/sync/fake-vault.test.ts` set the precedent: a double that nothing exercises is a double whose
 * bugs surface as mysterious failures in whatever happens to use it. Everything here is a property some
 * production path depends on, not a shape check.
 */
import { TFile, TFolder } from "obsidian";
import { describe, expect, it } from "vitest";
import * as viaRelative from "./obsidian";
import { Events, Platform, Vault, stubApp, vaultOf } from "./obsidian";

describe("module identity", () => {
	it("the alias and the relative path are the SAME module instance", async () => {
		// ⛔ If these ever diverge, every `__setRequestUrl` / `Platform.__setMobile` / `Notice.shown`
		// in the suite would write to one instance while the code under test reads another — and the
		// tests would stay green while proving nothing. Vite normalises both to one id today; this is
		// what notices if that stops being true.
		const viaAlias = await import("obsidian");
		expect(viaAlias.TFile).toBe(viaRelative.TFile);
		expect(viaAlias.Platform).toBe(viaRelative.Platform);
		expect(viaAlias.normalizePath).toBe(viaRelative.normalizePath);
	});
});

describe("Events", () => {
	it("trigger fires handlers; off and offref genuinely remove them", () => {
		const ev = new Events();
		let count = 0;
		const fn = (): void => {
			count += 1;
		};
		const ref = ev.on("x", fn);
		ev.trigger("x");
		expect(count).toBe(1);
		expect(ev.listenerCount("x")).toBe(1);

		ev.offref(ref);
		expect(ev.listenerCount("x")).toBe(0);
		ev.trigger("x");
		expect(count, "offref must actually unsubscribe").toBe(1);

		ev.on("y", fn);
		ev.off("y", fn);
		ev.trigger("y");
		expect(count, "off must actually unsubscribe").toBe(1);
	});

	it("passes the arguments through, and scopes by name", () => {
		const ev = new Events();
		const seen: unknown[] = [];
		ev.on("modify", (...a: never[]) => seen.push(...a));
		ev.trigger("other", "ignored");
		ev.trigger("modify", { path: "a.md" }, "old.md");
		expect(seen).toEqual([{ path: "a.md" }, "old.md"]);
	});

	it("a handler may unsubscribe during dispatch without skipping the next one", () => {
		const ev = new Events();
		const fired: string[] = [];
		const first = ev.on("e", () => {
			fired.push("first");
			ev.offref(first);
		});
		ev.on("e", () => fired.push("second"));
		ev.trigger("e");
		expect(fired, "splicing the array mid-iteration would drop `second`").toEqual([
			"first",
			"second",
		]);
	});
});

describe("the file tree", () => {
	it("returns real TFile instances, so `instanceof TFile` works", () => {
		// ⛔ This is the defect that made `ObsidianVault` untestable: TFile used to be a type alias,
		// erasing to `undefined`, so `instanceof TFile` threw `Right-hand side of 'instanceof' is not
		// an object` the moment anything reached it.
		const vault = new Vault({ "a.md": "x" });
		const file = vault.getAbstractFileByPath("a.md");
		expect(file).toBeInstanceOf(TFile);
		expect(file).not.toBeInstanceOf(TFolder);
	});

	it("splits basename and extension the way Obsidian does", () => {
		const vault = new Vault({ "notes/deep/My Note.md": "x", "img.tar.gz": "y", LICENSE: "z" });
		const md = vault.getFileByPath("notes/deep/My Note.md");
		expect(md?.name).toBe("My Note.md");
		expect(md?.basename).toBe("My Note");
		expect(md?.extension).toBe("md");
		expect(vault.getFileByPath("img.tar.gz")?.extension).toBe("gz");
		const noExt = vault.getFileByPath("LICENSE");
		expect(noExt?.extension).toBe("");
		expect(noExt?.basename).toBe("LICENSE");
	});

	it("gives a stable object per path, as Obsidian does", () => {
		const vault = new Vault({ "a.md": "x" });
		expect(vault.getAbstractFileByPath("a.md")).toBe(vault.getAbstractFileByPath("a.md"));
	});

	it("writing a nested path creates its ancestor folders", () => {
		const vault = new Vault({ "a/b/c.md": "x" });
		expect(vault.getFolderByPath("a")).toBeInstanceOf(TFolder);
		expect(vault.getFolderByPath("a/b")).toBeInstanceOf(TFolder);
		expect(vault.getAbstractFileByPath("a/b")).toBeInstanceOf(TFolder);
		expect(vault.getFolderByPath("a/b/c.md")).toBe(null);
	});
});

describe("the fidelity decisions that hold production precautions in place", () => {
	it("getMarkdownFiles excludes attachments", async () => {
		// ⛔ Load-bearing, not cosmetic. `src/crdt/crdt-sync.ts` derives `toRemove` from the markdown
		// set and hands it to Obsidian's TRASH. If attachments appeared there, an adopt reconcile
		// would bin every local attachment.
		const vault = new Vault({ "n.md": "x" });
		await vault.createBinary("pic.png", new ArrayBuffer(2));
		expect(vault.getMarkdownFiles().map((f) => f.path)).toEqual(["n.md"]);
		expect(
			vault
				.getFiles()
				.map((f) => f.path)
				.sort(),
		).toEqual(["n.md", "pic.png"]);
	});

	it("create() rejects on an existing path, as Obsidian does", async () => {
		// Without this, deleting `ObsidianVault.write`'s exists-check stays green.
		const vault = new Vault({ "a.md": "first" });
		await expect(vault.create("a.md", "second")).rejects.toThrow(/already exists/);
		expect(vault.snapshot()["a.md"], "a rejected create must not have written").toBe("first");
	});

	it("modify() refuses, pointing at process()", async () => {
		// `modify` and `process` are content-indistinguishable, so only a refusal here keeps
		// `obsidian-vault.ts`'s atomic read-modify-write decision falsifiable.
		const vault = new Vault({ "a.md": "x" });
		const file = vault.getFileByPath("a.md");
		if (file === null) throw new Error("fixture");
		await expect(vault.modify(file, "y")).rejects.toThrow(/use vault\.process\(\)/);
	});

	it("process() applies the function to the current content", async () => {
		const vault = new Vault({ "a.md": "hello" });
		const file = vault.getFileByPath("a.md");
		if (file === null) throw new Error("fixture");
		const result = await vault.process(file, (d) => `${d} world`);
		expect(result).toBe("hello world");
		expect(vault.snapshot()["a.md"]).toBe("hello world");
	});

	it("trash() and delete() are distinguishable, so `remove()` can be proven to trash", async () => {
		const vault = new Vault({ "a.md": "x", "b.md": "y" });
		const a = vault.getAbstractFileByPath("a.md");
		const b = vault.getAbstractFileByPath("b.md");
		if (a === null || b === null) throw new Error("fixture");
		await vault.trash(a, false);
		await vault.delete(b);
		expect(vault.trashed).toEqual(["a.md"]);
		expect(vault.hardDeleted).toEqual(["b.md"]);
		expect(vault.getAbstractFileByPath("a.md")).toBe(null);
	});

	it("unimplemented members throw by name rather than no-opping", () => {
		const vault = new Vault();
		expect(() => vault.getResourcePath()).toThrow(/Vault\.getResourcePath is not implemented/);
	});
});

describe("the adapter", () => {
	it("shares one tree with the vault", async () => {
		const vault = new Vault({ "a.md": "x" });
		expect(await vault.adapter.exists("a.md")).toBe(true);
		await vault.adapter.writeBinary("b.png", new Uint8Array([1, 2]).buffer as ArrayBuffer);
		expect(vault.getFileByPath("b.png")).toBeInstanceOf(TFile);
		expect(new Uint8Array(await vault.adapter.readBinary("b.png"))).toEqual(new Uint8Array([1, 2]));
	});

	it("stat distinguishes a file from a folder and reports null for neither", async () => {
		const vault = new Vault({ "a/b.md": "xyz" });
		expect((await vault.adapter.stat("a/b.md"))?.type).toBe("file");
		expect((await vault.adapter.stat("a"))?.type).toBe("folder");
		expect(await vault.adapter.stat("nope")).toBe(null);
	});
});

describe("Platform", () => {
	it("exposes isDesktop as well as isMobile", () => {
		// ⛔ The old double had only `isMobile`, while `src/ui/external-link.ts` reads `isDesktop` —
		// `undefined` under test, so a test would have silently taken the mobile arm.
		expect(Platform.isDesktop).toBe(true);
		expect(Platform.isMobile).toBe(false);
		const restore = Platform.__setMobile(true);
		expect(Platform.isDesktop).toBe(false);
		expect(Platform.isMobile).toBe(true);
		restore();
		expect(Platform.isDesktop).toBe(true);
	});
});

describe("stubApp", () => {
	it("hands back an App whose vault is the stub vault", () => {
		const app = stubApp({ "a.md": "x" }, "My Vault");
		expect(app.vault.getName()).toBe("My Vault");
		expect(vaultOf(app).snapshot()).toEqual({ "a.md": "x" });
		expect(app.vault.getMarkdownFiles().map((f) => f.path)).toEqual(["a.md"]);
	});
});
