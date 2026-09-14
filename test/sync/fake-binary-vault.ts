import type { BinaryFiles } from "../../src/sync/binary-vault";

/** In-memory `BinaryFiles` for attachment-sync engine tests. Tracks trashed paths for assertions. */
export class InMemoryBinaryVault implements BinaryFiles {
	private readonly files = new Map<string, ArrayBuffer>();
	readonly trashed: string[] = [];

	constructor(initial: Record<string, number[]> = {}) {
		for (const [path, bytes] of Object.entries(initial)) {
			this.files.set(path, new Uint8Array(bytes).buffer);
		}
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		const bytes = this.files.get(path);
		if (bytes === undefined) throw new Error(`not found: ${path}`);
		return Promise.resolve(bytes);
	}

	writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
		this.files.set(path, bytes);
		return Promise.resolve();
	}

	trash(path: string): Promise<void> {
		this.files.delete(path);
		this.trashed.push(path);
		return Promise.resolve();
	}

	list(): Promise<string[]> {
		return Promise.resolve([...this.files.keys()]);
	}

	/** Test helper: the bytes at `path` as a number[] (or undefined if absent). */
	/** Test helper: every path currently held, synchronously. */
	paths(): string[] {
		return [...this.files.keys()];
	}

	bytes(path: string): number[] | undefined {
		const b = this.files.get(path);
		return b === undefined ? undefined : [...new Uint8Array(b)];
	}
}
