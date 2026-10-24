import { safePath } from "../../src/sync/safe-path";
import type { VaultWriter } from "../../src/sync/vault";

/**
 * In-memory `VaultWriter` for engine tests.
 *
 * ⚠️ This fake mirrors `ObsidianVault`'s PATH POLICY and its markdown-only `list()`, and both are
 * deliberate rather than decorative. It used to do neither, and `test/sync/vault-contract.test.ts` —
 * one contract run against this and against the real adapter — is what found it:
 *
 *  - `list()` returned EVERY key, attachments included. `src/crdt/crdt-sync.ts` folds `vault.list()`
 *    into `local`, derives `toRemove` from it and sends each path to `vault.remove()` → Obsidian's
 *    TRASH. On an adopt reconcile that is every local attachment, and the invariant the production
 *    comment relies on by name (`crdt-sync.ts:701`) was asserted nowhere.
 *  - Unsafe paths were writable. A fake MORE PERMISSIVE than production is the worst kind: nine test
 *    files drive the sync engine through this, and every one of them was running against rules the
 *    real adapter does not have.
 *
 * The fail-closed shapes are copied from `ObsidianVault` exactly, asymmetries included: `exists`
 * answers false, `read` throws, and `write`/`remove` return silently.
 */
export class InMemoryVault implements VaultWriter {
	private readonly files = new Map<string, string>();

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
	}

	/** `ObsidianVault.resolve` in miniature: validate, or refuse. */
	private resolve(path: string): string | null {
		return safePath(path);
	}

	exists(path: string): Promise<boolean> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve(false);
		return Promise.resolve(this.files.has(p));
	}

	/** Markdown only, as the port documents and as `getMarkdownFiles()` gives. */
	list(): Promise<string[]> {
		return Promise.resolve([...this.files.keys()].filter((p) => p.endsWith(".md")));
	}

	read(path: string): Promise<string> {
		const p = this.resolve(path);
		if (p === null) throw new Error(`unsafe path: ${path}`);
		const content = this.files.get(p);
		if (content === undefined) throw new Error(`not found: ${path}`);
		return Promise.resolve(content);
	}

	/** The fake has no cache layer; the distinction only exists in Obsidian. */
	readCached(path: string): Promise<string> {
		return this.read(path);
	}

	write(path: string, content: string): Promise<void> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve();
		this.files.set(p, content);
		return Promise.resolve();
	}

	remove(path: string): Promise<void> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve();
		this.files.delete(p);
		return Promise.resolve();
	}

	/** Arrange a file without going through the subject, for the shared contract. */
	__seed(path: string, content: string): void {
		this.files.set(path, content);
	}

	/** Test helper: the full vault as a plain object. Includes non-markdown, unlike `list()`. */
	snapshot(): Record<string, string> {
		return Object.fromEntries(this.files);
	}
}
