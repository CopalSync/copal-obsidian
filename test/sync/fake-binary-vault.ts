import { safePath } from "../../src/sync/safe-path";
import type { BinaryFiles } from "../../src/sync/binary-vault";

/**
 * In-memory `BinaryFiles` for attachment-sync engine tests. Tracks trashed paths for assertions.
 *
 * ⚠️ Mirrors `ObsidianBinaryVault`'s path policy and its markdown-excluding `list()`. It used to do
 * neither — `test/sync/binary-vault.test.ts` runs one contract against this and the real adapter, which
 * is what found it. A fake that accepts paths production refuses, or lists notes on the attachment
 * channel, makes every engine test above it describe a world that does not ship.
 */
export class InMemoryBinaryVault implements BinaryFiles {
	private readonly files = new Map<string, ArrayBuffer>();
	/** mtimes, so the P4 stat gate has something to compare. Bumped on every write. */
	private readonly mtimes = new Map<string, number>();
	private clock = 1;
	readonly trashed: string[] = [];
	/** Counts `readBinary` calls, so a test can prove the stat gate avoided the read. */
	reads = 0;

	constructor(initial: Record<string, number[]> = {}) {
		for (const [path, bytes] of Object.entries(initial)) {
			this.files.set(path, new Uint8Array(bytes).buffer);
			this.mtimes.set(path, this.clock++);
		}
	}

	/** `ObsidianBinaryVault.resolve` in miniature: validate, or refuse. */
	private resolve(path: string): string | null {
		return safePath(path);
	}

	exists(path: string): Promise<boolean> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve(false);
		return Promise.resolve(this.files.has(p));
	}

	stat(path: string): Promise<{ size: number; mtime: number } | null> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve(null);
		const bytes = this.files.get(p);
		if (bytes === undefined) return Promise.resolve(null);
		return Promise.resolve({ size: bytes.byteLength, mtime: this.mtimes.get(p) ?? 0 });
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		const p = this.resolve(path);
		if (p === null) throw new Error(`unsafe path: ${path}`);
		this.reads += 1;
		const bytes = this.files.get(p);
		if (bytes === undefined) throw new Error(`not found: ${path}`);
		return Promise.resolve(bytes);
	}

	writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve();
		this.files.set(p, bytes);
		this.mtimes.set(p, this.clock++);
		return Promise.resolve();
	}

	trash(path: string): Promise<void> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve();
		if (this.files.delete(p)) {
			this.mtimes.delete(p);
			this.trashed.push(p);
		}
		return Promise.resolve();
	}

	/** Attachments only, as `ObsidianBinaryVault.list()` gives — never markdown. */
	list(): Promise<string[]> {
		return Promise.resolve([...this.files.keys()].filter((p) => !p.endsWith(".md")));
	}

	/** Test helper: every path currently held, synchronously. Includes markdown, unlike `list()`. */
	paths(): string[] {
		return [...this.files.keys()];
	}

	/** Test helper: pretend the file changed on disk without going through `writeBinary`. */
	__touch(path: string): void {
		this.mtimes.set(path, this.clock++);
	}

	/** Test helper: the bytes at `path` as a number[] (or undefined if absent). */
	bytes(path: string): number[] | undefined {
		const b = this.files.get(path);
		return b === undefined ? undefined : [...new Uint8Array(b)];
	}
}
