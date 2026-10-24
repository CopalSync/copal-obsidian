/**
 * The attachment channel: one contract against both `BinaryFiles` implementations, plus the parts
 * specific to `ObsidianBinaryVault`.
 *
 * `ObsidianBinaryVault` had zero test references before this file, and it is the ONLY consumer of
 * `app.vault.adapter` in the codebase — the surface G2 will move onto the documented Vault API, and the
 * surface P4 will put a stat gate in front of. Neither is assertable without this.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/log";
import { mimeForPath, ObsidianBinaryVault } from "../../src/sync/binary-vault";
import { stubApp, vaultOf } from "../stubs/obsidian";
import { describeBinaryFilesContract, type BinaryVaultUnderTest } from "./binary-vault-contract";
import { InMemoryBinaryVault } from "./fake-binary-vault";

describe("BinaryFiles contract — InMemoryBinaryVault", () => {
	describeBinaryFilesContract((): BinaryVaultUnderTest => {
		const files = new InMemoryBinaryVault();
		return {
			files,
			seed: (path, bytes) =>
				void files.writeBinary(path, new Uint8Array(bytes).buffer as ArrayBuffer),
			held: () => files.paths(),
			bytes: (path) => files.bytes(path),
		};
	});
});

describe("BinaryFiles contract — ObsidianBinaryVault over the obsidian double", () => {
	describeBinaryFilesContract((): BinaryVaultUnderTest => {
		const app = stubApp();
		const stub = vaultOf(app);
		return {
			files: new ObsidianBinaryVault(app),
			seed: (path, bytes) =>
				void stub.__put(path, { bytes: new Uint8Array(bytes).buffer as ArrayBuffer }),
			held: () => [...stub.__entries().keys()],
			bytes: (path) => {
				const e = stub.__entries().get(path);
				return e?.bytes === undefined ? undefined : [...new Uint8Array(e.bytes)];
			},
		};
	});
});

// `log.warnOnce` remembers across tests by design; reset it so a count here is about this test.
beforeEach(() => log.__resetOnce());

function subject(files: Record<string, number[]> = {}) {
	const app = stubApp();
	const stub = vaultOf(app);
	for (const [path, bytes] of Object.entries(files)) {
		stub.__put(path, { bytes: new Uint8Array(bytes).buffer as ArrayBuffer });
	}
	return { files: new ObsidianBinaryVault(app), stub, app };
}

describe("ObsidianBinaryVault specifics", () => {
	it("uses the documented Vault API for bytes, never vault.adapter (G2)", async () => {
		// This assertion was written the other way round, pinning the `adapter.*` calls, with a note that
		// G2 should REWRITE it rather than delete it. This is that rewrite. The adapter bypasses
		// Obsidian's file index — a write through it leaves `TFile.stat` stale, which is also why P4's
		// gate could not exist until this moved.
		const { files, app } = subject();
		const adapterWrite = vi.spyOn(app.vault.adapter, "writeBinary");
		const adapterRead = vi.spyOn(app.vault.adapter, "readBinary");
		const createBinary = vi.spyOn(app.vault, "createBinary");
		const modifyBinary = vi.spyOn(app.vault, "modifyBinary");
		const readBinary = vi.spyOn(app.vault, "readBinary");

		await files.writeBinary("pic.png", new Uint8Array([4, 5]).buffer as ArrayBuffer);
		expect(createBinary, "a new attachment is created through the Vault API").toHaveBeenCalledTimes(
			1,
		);

		await files.writeBinary("pic.png", new Uint8Array([6]).buffer as ArrayBuffer);
		expect(
			modifyBinary,
			"an existing one is modified, since createBinary throws on it",
		).toHaveBeenCalledTimes(1);

		await files.readBinary("pic.png");
		expect(readBinary).toHaveBeenCalledTimes(1);

		expect(adapterWrite, "the low-level adapter must not be touched").not.toHaveBeenCalled();
		expect(adapterRead).not.toHaveBeenCalled();
	});

	it("stat() reports size and mtime without reading the file", async () => {
		// Free over the Vault API: `TFile.stat` is already in memory. This is the whole basis of P4's gate.
		const { files, app } = subject();
		const readBinary = vi.spyOn(app.vault, "readBinary");
		await files.writeBinary("pic.png", new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
		const stat = await files.stat("pic.png");
		expect(stat?.size).toBe(3);
		expect(typeof stat?.mtime).toBe("number");
		expect(readBinary, "a stat must not read the bytes").not.toHaveBeenCalled();
		expect(await files.stat("absent.png")).toBe(null);
	});

	it("stat() refuses an unsafe path rather than consulting the vault", async () => {
		const { files, app } = subject();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const lookup = vi.spyOn(app.vault, "getFileByPath");
		expect(await files.stat("../escape.png")).toBe(null);
		expect(lookup).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("trash() goes to Obsidian's TRASH, never a hard delete", async () => {
		const { files, stub } = subject({ "pic.png": [1] });
		await files.trash("pic.png");
		expect(stub.trashed).toEqual(["pic.png"]);
		expect(stub.hardDeleted, "an attachment delete must stay recoverable").toEqual([]);
	});

	it("trash() on a path with no vault file is a silent no-op", async () => {
		const { files, stub } = subject();
		await files.trash("never-there.png");
		expect(stub.trashed).toEqual([]);
	});

	it("writeBinary() creates ancestor folders before writing", async () => {
		const { files, stub } = subject();
		await files.writeBinary("assets/img/deep/pic.png", new Uint8Array([1]).buffer as ArrayBuffer);
		expect(stub.getFolderByPath("assets")).not.toBe(null);
		expect(stub.getFolderByPath("assets/img")).not.toBe(null);
		expect(stub.getFolderByPath("assets/img/deep")).not.toBe(null);
	});

	it("list() is the complement of the note channel — attachments only", async () => {
		const { files, stub } = subject({ "pic.png": [1], "doc.pdf": [2] });
		stub.__put("note.md", { text: "words" });
		expect([...(await files.list())].sort()).toEqual(["doc.pdf", "pic.png"]);
	});

	it("refuses unsafe paths at every sink", async () => {
		const { files, stub, app } = subject();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const exists = vi.spyOn(app.vault.adapter, "exists");
		const write = vi.spyOn(app.vault.adapter, "writeBinary");
		const lookup = vi.spyOn(app.vault, "getAbstractFileByPath");

		for (const bad of ["../escape.png", "/abs.png", "a/../../b.png", "~/h.png", "C:/x.png"]) {
			expect(await files.exists(bad)).toBe(false);
			await files.writeBinary(bad, new Uint8Array([1]).buffer as ArrayBuffer);
			await files.trash(bad);
			await expect(Promise.resolve().then(() => files.readBinary(bad))).rejects.toThrow(
				/unsafe path/,
			);
		}
		// Every refusal happens before the sink, which is what distinguishes a real guard from a path
		// that merely happened not to exist.
		expect(exists, "a refused path never reaches the adapter").not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(lookup).not.toHaveBeenCalled();
		expect(stub.__entries().size).toBe(0);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("ObsidianBinaryVault and the config folder (S1)", () => {
	it("never writes into the config folder, in any case or by its 8.3 short name", async () => {
		// The reported exploit: on a case-insensitive filesystem `.Obsidian/plugins/copal/main.js` is
		// this plugin's own code, and the next load runs whatever the server wrote there.
		const { files, stub, app } = subject();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const create = vi.spyOn(app.vault, "createBinary");
		const folder = vi.spyOn(app.vault, "createFolder");
		for (const bad of [
			".obsidian/plugins/copal/main.js",
			".Obsidian/plugins/copal/main.js",
			"OBSIDI~1/plugins/copal/main.js",
		]) {
			await files.writeBinary(bad, new Uint8Array([1]).buffer as ArrayBuffer);
			expect(await files.exists(bad)).toBe(false);
		}
		expect(create, "nothing reaches the vault").not.toHaveBeenCalled();
		expect(folder, "not even a parent folder").not.toHaveBeenCalled();
		expect(stub.__entries().size).toBe(0);
		warn.mockRestore();
	});

	it("refuses a renamed config folder by what configDir says it is now", async () => {
		const { files, stub, app } = subject();
		app.vault.configDir = "settings";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const bad of ["settings/plugins/x/main.js", "Settings/plugins/x/main.js"]) {
			await files.writeBinary(bad, new Uint8Array([1]).buffer as ArrayBuffer);
			expect(await files.stat(bad)).toBe(null);
		}
		expect(stub.__entries().size).toBe(0);
		await files.writeBinary("settings-art/pic.png", new Uint8Array([1]).buffer as ArrayBuffer);
		expect([...stub.__entries().keys()]).toEqual(["settings-art/pic.png"]);
		warn.mockRestore();
	});
});

describe("mimeForPath", () => {
	it("maps the common attachment extensions and defaults to octet-stream", () => {
		expect(mimeForPath("a/b/pic.PNG")).toBe("image/png");
		expect(mimeForPath("doc.pdf")).toBe("application/pdf");
		expect(mimeForPath("weird.zzz")).toBe("application/octet-stream");
		expect(mimeForPath("noextension")).toBe("application/octet-stream");
	});
});
