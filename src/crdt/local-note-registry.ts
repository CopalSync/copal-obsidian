import type { LocalDocStore } from "./local-doc-store";
import { LocalNote } from "./local-note";
import type { VaultWriter } from "../sync/vault";

/**
 * Lazily creates + caches a `LocalNote` per path over a shared `LocalDocStore`. The single place the rest
 * of the plugin gets a note's persisted local Y.Doc + its `.md` binding; `main.ts` routes every edit
 * (editor or external file change) and every sync flush through it, so a note has exactly one local doc.
 */
export class LocalNoteRegistry {
	private readonly notes = new Map<string, LocalNote>();

	constructor(
		private readonly store: LocalDocStore,
		private readonly vault: VaultWriter,
	) {}

	/** Get (or lazily create) the note's `LocalNote`; `whenLoaded` resolves once its doc is rehydrated. */
	note(path: string): { note: LocalNote; whenLoaded: Promise<void> } {
		const existing = this.notes.get(path);
		if (existing) return { note: existing, whenLoaded: Promise.resolve() };
		const { doc, whenLoaded } = this.store.open(path);
		const note = new LocalNote(doc, path, this.vault);
		this.notes.set(path, note);
		return { note, whenLoaded };
	}

	/** The note if it's already open in memory (no creation). */
	get(path: string): LocalNote | undefined {
		return this.notes.get(path);
	}

	/** Every note that already has a persisted local doc (so reconcile can skip it). */
	listPersisted(): Promise<string[]> {
		return this.store.listPersisted();
	}

	/** Rename a note `oldPath` → `newPath`, preserving its CRDT lineage (delegates to the store), and drop the
	 *  stale cached `LocalNote` so the new path is lazily re-wrapped over the renamed doc on next access. */
	async rename(oldPath: string, newPath: string): Promise<void> {
		this.notes.delete(oldPath);
		await this.store.rename(oldPath, newPath);
	}

	/** Drop the note from memory (keeps its persisted data). */
	close(path: string): void {
		this.store.close(path);
		this.notes.delete(path);
	}

	/** Permanently delete the note's persisted local data (confirmed remote delete / bring-existing purge). */
	async destroy(path: string): Promise<void> {
		this.notes.delete(path);
		await this.store.destroy(path);
	}

	/** Wipe every persisted local doc + drop the in-memory cache (clean disconnect). */
	async destroyAll(): Promise<void> {
		this.notes.clear();
		await this.store.destroyAll();
	}
}
