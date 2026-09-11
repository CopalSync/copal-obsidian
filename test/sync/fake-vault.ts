import type { VaultWriter } from "../../src/sync/vault";

/** In-memory `VaultWriter` for engine tests. */
export class InMemoryVault implements VaultWriter {
	private readonly files = new Map<string, string>();

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}

	list(): Promise<string[]> {
		return Promise.resolve([...this.files.keys()]);
	}

	read(path: string): Promise<string> {
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`not found: ${path}`);
		return Promise.resolve(content);
	}

	write(path: string, content: string): Promise<void> {
		this.files.set(path, content);
		return Promise.resolve();
	}

	remove(path: string): Promise<void> {
		this.files.delete(path);
		return Promise.resolve();
	}

	/** Test helper: the full vault as a plain object. */
	snapshot(): Record<string, string> {
		return Object.fromEntries(this.files);
	}
}
