/** The persisted sync cursor, under the `sync` key of the plugin's `data.json`. */
export interface SyncData {
  lastSeq: number;
  /** Note paths known to be on the server as of the last reconcile — the tombstone signal: a local note
   *  absent from the server is a genuinely-new note if it was never here, or a remote delete if it was. */
  knownServer: string[];
}

/**
 * Tracks the change-notification-bus cursor (`lastSeq`) — the last journal sequence the client applied, so
 * a reconnect replays only what's new — plus `knownServer`, the set of paths on the server at the last
 * reconcile. Under local-first there is **no per-file hash journal**: note-text convergence is Yjs
 * state-vector exchange, not content hashing. `knownServer` lets reconcile distinguish a brand-new local
 * note (push) from one deleted on the server (remove locally) instead of resurrecting the delete.
 */
export class SyncState {
  private data: SyncData = { lastSeq: 0, knownServer: [] };

  constructor(
    private readonly load: () => Promise<SyncData | null>,
    private readonly save: (data: SyncData) => Promise<void>,
  ) {}

  async init(): Promise<void> {
    const loaded = await this.load();
    // Back-compat: pre-upgrade `sync` records only had `{ lastSeq }`, so default `knownServer` to `[]`.
    this.data = { lastSeq: loaded?.lastSeq ?? 0, knownServer: loaded?.knownServer ?? [] };
  }

  get lastSeq(): number {
    return this.data.lastSeq;
  }

  set lastSeq(seq: number) {
    this.data.lastSeq = seq;
  }

  get knownServer(): string[] {
    return this.data.knownServer;
  }

  set knownServer(paths: string[]) {
    this.data.knownServer = paths;
  }

  async persist(): Promise<void> {
    await this.save(this.data);
  }

  /** Wipe the cursor back to a fresh state (on disconnect) so a later connect to any vault starts clean —
   *  no stale `knownServer` tombstones bleeding into the next vault's reconcile. */
  async reset(): Promise<void> {
    this.data = { lastSeq: 0, knownServer: [] };
    await this.persist();
  }
}
