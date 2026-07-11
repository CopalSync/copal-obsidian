/**
 * The vault operations the sync engine needs, abstracted so the engine is unit-testable against an
 * in-memory fake. The real implementation (over Obsidian's `app.vault`) is wired in `main.ts`.
 */
export interface VaultWriter {
  exists(path: string): Promise<boolean>;
  /** Every note path in the vault (markdown files; excludes Obsidian's trash) — the reconcile's push set. */
  list(): Promise<string[]>;
  /** Read a note's current content (only called when it exists). */
  read(path: string): Promise<string>;
  /** Create or overwrite a note, creating parent folders as needed. */
  write(path: string, content: string): Promise<void>;
  /** Delete a note (no-op if absent). */
  remove(path: string): Promise<void>;
}
