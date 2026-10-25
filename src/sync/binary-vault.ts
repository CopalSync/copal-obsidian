import { log } from "../log";
import { type App, normalizePath } from "obsidian";
import { isConfigDirPath, safePath } from "./safe-path";

/**
 * The binary-file operations the attachment-sync engine needs, abstracted so the engine is unit-testable
 * against an in-memory fake. Parallel to `VaultWriter` (which is markdown/text only), keeping binaries on
 * a separate, provably-non-CRDT channel. The real implementation over Obsidian's Vault API is wired in `main.ts`.
 */
export interface BinaryFiles {
	exists(path: string): Promise<boolean>;
	/**
	 * Size and mtime without reading the file, or `null` if it is not there.
	 *
	 * ⚠️ This is the cheap half of the attachment reconcile (ROADMAP P4). Over Obsidian's Vault API it is
	 * FREE — `TFile.stat` is already in memory, no I/O — which is why G2 had to land before P4 could use
	 * it: `DataAdapter.stat()` is an async call returning a different shape.
	 */
	stat(path: string): Promise<{ size: number; mtime: number } | null>;
	/** Read a file's raw bytes (only called when it exists). */
	readBinary(path: string): Promise<ArrayBuffer>;
	/** Create or overwrite a file, creating parent folders as needed. */
	writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
	/** Delete → Obsidian trash (recoverable), never a hard unlink — the same invariant as note deletes. */
	trash(path: string): Promise<void>;
	/** Every vault-visible attachment (non-`.md`, excluding `.obsidian` config + Obsidian's trash). */
	list(): Promise<string[]>;
}

/**
 * Real `BinaryFiles` over Obsidian's documented **Vault API**.
 *
 * ⚠️ It used to reach through `app.vault.adapter` for bytes (ROADMAP G2). The adapter is the lower-level
 * filesystem surface: it bypasses Obsidian's own file index, so a write through it left `TFile.stat`
 * stale, and it is the surface the review guidelines ask plugins not to use. Moving to
 * `getFileByPath`/`createBinary`/`modifyBinary`/`readBinary`/`getFolderByPath` also makes `stat()` free,
 * which is what P4's gate needs.
 */
export class ObsidianBinaryVault implements BinaryFiles {
	constructor(private readonly app: App) {}

	/** Validate (server-originated paths), refuse the config folder (S1), then canonicalize before touching
	 *  the vault — see ObsidianVault. */
	private resolve(path: string): string | null {
		const safe = safePath(path);
		if (safe === null || isConfigDirPath(safe, this.app.vault.configDir)) {
			log.warnOnce(
				`attachment:${path}`,
				`refusing unsafe attachment path: ${JSON.stringify(path)}`,
			);
			return null;
		}
		// A path `normalizePath` would change names a different file here, never this one.
		// Refused silently, as an unsafe path is: an attachment pulled under it would overwrite, or a
		// delete trash, the file Obsidian folds it onto.
		if (normalizePath(safe) !== safe) {
			log.warnOnce(
				`attachment:${path}`,
				`refusing a path Obsidian would fold: ${JSON.stringify(path)}`,
			);
			return null;
		}
		return safe;
	}

	exists(path: string): Promise<boolean> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve(false);
		return Promise.resolve(this.app.vault.getFileByPath(p) !== null);
	}

	/** Free: `TFile.stat` is already loaded, so this touches no filesystem. */
	stat(path: string): Promise<{ size: number; mtime: number } | null> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve(null);
		const file = this.app.vault.getFileByPath(p);
		if (file === null) return Promise.resolve(null);
		return Promise.resolve({ size: file.stat.size, mtime: file.stat.mtime });
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		const p = this.resolve(path);
		if (p === null) throw new Error(`unsafe path: ${path}`);
		const file = this.app.vault.getFileByPath(p);
		if (file === null) throw new Error(`not a file: ${path}`);
		return this.app.vault.readBinary(file);
	}

	async writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
		const p = this.resolve(path);
		if (p === null) return;
		const existing = this.app.vault.getFileByPath(p);
		if (existing !== null) {
			// `modifyBinary`, not create: `createBinary` throws on an occupied path, and this is the
			// remote → local write, so the file is usually already there.
			await this.app.vault.modifyBinary(existing, bytes);
			return;
		}
		await this.ensureFolder(p);
		await this.app.vault.createBinary(p, bytes);
	}

	async trash(path: string): Promise<void> {
		const p = this.resolve(path);
		if (p === null) return;
		const file = this.app.vault.getFileByPath(p);
		if (file) await this.app.vault.trash(file, false);
	}

	/** All vault attachments: every `TFile` that isn't markdown. `getFiles()` already excludes `.trash`, and
	 *  `.obsidian` config files aren't vault files at all — so this is attachments only. */
	list(): Promise<string[]> {
		return Promise.resolve(
			this.app.vault
				.getFiles()
				.filter((f) => !f.path.endsWith(".md"))
				.map((f) => f.path),
		);
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/");
		parts.pop();
		let dir = "";
		for (const part of parts) {
			dir = dir ? `${dir}/${part}` : part;
			if (this.app.vault.getFolderByPath(dir) === null) {
				// oxlint-disable-next-line no-await-in-loop
				await this.app.vault.createFolder(dir).catch(() => undefined);
			}
		}
	}
}

/** Guess a content type from a path's extension so `putFile` stores a useful `Content-Type` (Obsidian
 *  itself renders attachments by extension; this is for browser and REST fetches). Defaults to octet-stream. */
export function mimeForPath(path: string): string {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return MIME[ext] ?? "application/octet-stream";
}

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	flac: "audio/flac",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	json: "application/json",
	zip: "application/zip",
	canvas: "application/json",
};
