import { type App, normalizePath } from "obsidian";
import { safePath } from "./safe-path";

/**
 * The binary-file operations the attachment-sync engine needs, abstracted so the engine is unit-testable
 * against an in-memory fake. Parallel to `VaultWriter` (which is markdown/text only), keeping binaries on
 * a separate, provably-non-CRDT channel. The real implementation over `app.vault.adapter` is in `main.ts`.
 */
export interface BinaryFiles {
	exists(path: string): Promise<boolean>;
	/** Read a file's raw bytes (only called when it exists). */
	readBinary(path: string): Promise<ArrayBuffer>;
	/** Create or overwrite a file, creating parent folders as needed. */
	writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
	/** Delete → Obsidian trash (recoverable), never a hard unlink — the same invariant as note deletes. */
	trash(path: string): Promise<void>;
	/** Every vault-visible attachment (non-`.md`, excluding `.obsidian` config + Obsidian's trash). */
	list(): Promise<string[]>;
}

/** Real `BinaryFiles` over Obsidian's `app.vault` (files) + `app.vault.adapter` (raw bytes). */
export class ObsidianBinaryVault implements BinaryFiles {
	constructor(private readonly app: App) {}

	/** Validate (server-originated paths) then canonicalize before touching the adapter — see ObsidianVault. */
	private resolve(path: string): string | null {
		const safe = safePath(path);
		if (safe === null) {
			console.warn(`[copal] refusing unsafe attachment path: ${JSON.stringify(path)}`);
			return null;
		}
		return normalizePath(safe);
	}

	exists(path: string): Promise<boolean> {
		const p = this.resolve(path);
		if (p === null) return Promise.resolve(false);
		return this.app.vault.adapter.exists(p);
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		const p = this.resolve(path);
		if (p === null) throw new Error(`unsafe path: ${path}`);
		return this.app.vault.adapter.readBinary(p);
	}

	async writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
		const p = this.resolve(path);
		if (p === null) return;
		await this.ensureFolder(p);
		await this.app.vault.adapter.writeBinary(p, bytes);
	}

	async trash(path: string): Promise<void> {
		const p = this.resolve(path);
		if (p === null) return;
		const file = this.app.vault.getAbstractFileByPath(p);
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
			if (this.app.vault.getAbstractFileByPath(dir) === null) {
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
