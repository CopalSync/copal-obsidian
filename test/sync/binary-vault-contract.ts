/**
 * One contract, every `BinaryFiles`.
 *
 * The attachment channel has the same two-implementation shape as `VaultWriter` — `InMemoryBinaryVault`
 * for engine tests, `ObsidianBinaryVault` in production — and had the same two divergences:
 * `list()` returned everything including markdown (production excludes `.md` at
 * `src/sync/binary-vault.ts:67`), and unsafe paths were writable.
 *
 * ⛔ Not a `*.test.ts`: `scripts/assert-suites-ran.mjs` counts test files, and a shared factory is not
 * a suite.
 */
import { expect, it } from "vitest";
import type { BinaryFiles } from "../../src/sync/binary-vault";

export interface BinaryVaultUnderTest {
	files: BinaryFiles;
	seed(path: string, bytes: number[]): void;
	/** Every path currently held, markdown included, so a leak into `list()` is visible. */
	held(): string[];
	bytes(path: string): number[] | undefined;
}

const u8 = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer as ArrayBuffer;

export function describeBinaryFilesContract(make: () => BinaryVaultUnderTest): void {
	it("writeBinary() then readBinary() round-trips the bytes", async () => {
		const t = make();
		await t.files.writeBinary("pic.png", u8([1, 2, 3]));
		expect([...new Uint8Array(await t.files.readBinary("pic.png"))]).toEqual([1, 2, 3]);
	});

	it("exists() reflects what is there", async () => {
		const t = make();
		t.seed("pic.png", [9]);
		expect(await t.files.exists("pic.png")).toBe(true);
		expect(await t.files.exists("nope.png")).toBe(false);
	});

	it("writeBinary() creates missing ancestor folders", async () => {
		const t = make();
		await t.files.writeBinary("assets/deep/pic.png", u8([7]));
		expect(t.bytes("assets/deep/pic.png")).toEqual([7]);
	});

	it("writeBinary() overwrites existing bytes", async () => {
		const t = make();
		t.seed("pic.png", [1]);
		await t.files.writeBinary("pic.png", u8([2, 2]));
		expect(t.bytes("pic.png")).toEqual([2, 2]);
	});

	it("readBinary() fails on an absent path", async () => {
		const t = make();
		await expect(Promise.resolve().then(() => t.files.readBinary("nope.png"))).rejects.toThrow();
	});

	it("trash() removes the file and is a no-op on an absent path", async () => {
		const t = make();
		t.seed("pic.png", [1]);
		await t.files.trash("pic.png");
		expect(await t.files.exists("pic.png")).toBe(false);
		await t.files.trash("pic.png");
	});

	it("list() EXCLUDES markdown — the attachment channel is the complement of the note channel", async () => {
		// The two channels partition the vault by extension. Markdown leaking into this list would put
		// notes onto the file-level LWW path, which is precisely the quarantine the CRDT spine relies on.
		const t = make();
		t.seed("note.md", [1]);
		t.seed("pic.png", [2]);
		t.seed("doc.pdf", [3]);
		expect([...(await t.files.list())].sort()).toEqual(["doc.pdf", "pic.png"]);
	});

	it("refuses unsafe paths, writing nothing", async () => {
		const t = make();
		for (const bad of ["../escape.png", "/abs.png", "a/../../b.png", "~/h.png", "bad\u0000.png"]) {
			await t.files.writeBinary(bad, u8([1]));
			expect(t.held(), `writing ${JSON.stringify(bad)} must not create anything`).toEqual([]);
		}
		expect(await t.files.exists("../escape.png")).toBe(false);
		await t.files.trash("../escape.png"); // must not throw
	});
}
