import { log } from "../log";
import { type App, normalizePath, TFile } from "obsidian";
import { isConfigDirPath, safePath } from "./safe-path";
import type { VaultWriter } from "./vault";

/**
 * A server path Obsidian would store under another name, which on this device is another note.
 *
 * ⛔ Obsidian's `normalizePath` maps U+00A0/U+202F to a space and composes to NFC, so a
 * server note `Meeting<NBSP>notes.md` and the user's `Meeting notes.md` are one file here. Writing the
 * first wrote over the second, pushed it back into the server's copy of the user's note, and a later
 * delete of the variant trashed the real one. Thrown by `write` so the sync engine can say so; read,
 * exists and remove treat such a path as absent.
 */
export class UnrepresentablePathError extends Error {
	constructor(
		readonly path: string,
		readonly stored: string,
	) {
		super(
			`Obsidian would store ${JSON.stringify(path)} as ${JSON.stringify(stored)}, which is a different note`,
		);
		this.name = "UnrepresentablePathError";
	}
}

/** The name Obsidian would store a safe `path` under, when that is not `path` itself; else null. */
export function foldedName(path: string): string | null {
	const safe = safePath(path);
	if (safe === null) return null;
	const stored = normalizePath(safe);
	return stored === safe ? null : stored;
}

/** Real `VaultWriter` over Obsidian's `app.vault`. Creates parent folders as needed on write. */
export class ObsidianVault implements VaultWriter {
	constructor(private readonly app: App) {}

	/**
	 * Defense-in-depth: every path that reaches a filesystem sink here originates from the server, so
	 * validate (`safePath`) then canonicalize (`normalizePath`) before touching `app.vault`. `safePath`
	 * fails closed on traversal/absolute paths (`normalizePath` alone does NOT strip `..`); a rejected path
	 * returns `null` and the caller no-ops rather than writing outside the vault. It also refuses the
	 * vault's config folder by what `configDir` says it is called now (S1), which `safePath` cannot know.
	 * The boundary validators (`api.ts`/`live.ts`) already vet server paths — this is the last line of
	 * defense.
	 */
	private resolve(path: string): string | null {
		const safe = safePath(path);
		if (safe === null || isConfigDirPath(safe, this.app.vault.configDir)) {
			log.warnOnce(`vault:${path}`, `refusing unsafe vault path: ${JSON.stringify(path)}`);
			return null;
		}
		// A path `normalizePath` would change names a different note here, never this one.
		if (normalizePath(safe) !== safe) {
			log.warnOnce(`vault:${path}`, `refusing a path Obsidian would fold: ${JSON.stringify(path)}`);
			return null;
		}
		return safe;
	}

	exists(path: string): Promise<boolean> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve(false);
		return Promise.resolve(this.app.vault.getAbstractFileByPath(p) !== null);
	}

	/** All markdown notes in the vault. `getMarkdownFiles()` already excludes `.trash`, so trashed notes
	 *  never bring-existing back up to the server. */
	list(): Promise<string[]> {
		return Promise.resolve(this.app.vault.getMarkdownFiles().map((f) => f.path));
	}

	read(path: string): Promise<string> {
		return this.readWith(path, (file) => this.app.vault.read(file));
	}

	/** `cachedRead` is what Obsidian documents for reading content you are not about to modify in place;
	 *  it serves the cache instead of hitting disk, which matters on the per-edit read-at-dequeue path. */
	readCached(path: string): Promise<string> {
		return this.readWith(path, (file) => this.app.vault.cachedRead(file));
	}

	private readWith(path: string, read: (file: TFile) => Promise<string>): Promise<string> {
		const p = this.resolve(path);
		if (p === null) throw new Error(`unsafe path: ${path}`);
		const file = this.app.vault.getAbstractFileByPath(p);
		if (!(file instanceof TFile)) throw new Error(`not a file: ${path}`);
		return read(file);
	}

	async write(path: string, content: string): Promise<void> {
		const stored = foldedName(path);
		if (stored !== null) throw new UnrepresentablePathError(path, stored);
		const p = this.resolve(path);
		if (p === null) return;
		const existing = this.app.vault.getAbstractFileByPath(p);
		if (existing instanceof TFile) {
			// ⚠️ `process`, not `modify`. This is the REMOTE → LOCAL write path, so it can land while
			// the user is typing in the same file. `process` is the atomic read-modify-write Obsidian
			// documents for background edits; `modify` is a blind overwrite that can interleave with
			// another vault operation. The content is authoritative either way — what this buys is
			// that no other writer can slip between the read and the write.
			await this.app.vault.process(existing, () => content);
			return;
		}
		await this.ensureFolder(p);
		await this.app.vault.create(p, content);
	}

	/** A propagated remote delete goes to Obsidian's `.trash` (recoverable) — never a hard, unrecoverable unlink. */
	async remove(path: string): Promise<void> {
		const p = this.resolve(path);
		if (p === null) return;
		const file = this.app.vault.getAbstractFileByPath(p);
		if (file) await this.app.vault.trash(file, false);
	}

	/** Create each ancestor folder of `path` that doesn't already exist. */
	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/");
		parts.pop(); // drop the filename
		let dir = "";
		for (const part of parts) {
			dir = dir ? `${dir}/${part}` : part;
			if (this.app.vault.getAbstractFileByPath(dir) === null) {
				// oxlint-disable-next-line no-await-in-loop
				await this.app.vault.createFolder(dir).catch(() => undefined); // ignore "already exists" races
			}
		}
	}
}
