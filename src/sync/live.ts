import type { SyncStatus } from "../ui/status";
import type { Change, SyncApi } from "./api";
import { assertWssUrl } from "./safe-url";
import { closeCode, WS_REAUTH_CLOSE } from "./ws-close";
import type { SyncState } from "./state";
import { parseChange } from "./validate";

export type { SyncStatus };

/**
 * The sync target the live client drives: a full reconcile + per-change routing. Implemented by
 * `CrdtSync`, which pulls the R2 projection (no clobber) or transient-merges the note's Y.Doc.
 */
export interface RemoteSink {
	/** Converge with the server given the paths known-on-server at the last reconcile; returns the new
	 *  cursor (server contents now + the journal head) for the client to persist. `mode` selects the
	 *  first-connect behaviour: `merge` (union, default) or `adopt` (remote-first: pull + trash local-only). */
	reconcile(
		known: readonly string[],
		mode?: "merge" | "adopt",
	): Promise<{ knownServer: string[]; head: number }>;
	onRemoteChange(change: Change): Promise<void>;
	/** Replay any durably-queued mutations (offline deletes) — called when the WS (re)connects. */
	drainPending?(): Promise<void>;
}

/**
 * Drives the change-notification bus: reconcile from the manifest, then hold a live WebSocket to the
 * vault's VaultSync DO and route each journal frame to the sink (CrdtSync). Reconnects (with a fresh
 * ticket) on drop. The WebSocket authenticates via the one-time ticket in the query string — no header.
 * Under full-vault CRDT the plugin never pushes `.md` up (local edits flow through the Y.Doc), so there
 * are no `plugin:<device>` echoes to filter — the sink's own materialize frames are idempotent.
 */
export class SyncClient {
	private ws: WebSocket | undefined;
	private stopped = true;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly api: SyncApi,
		private readonly sink: RemoteSink,
		private readonly state: SyncState,
		private readonly onStatus: (s: SyncStatus) => void = () => undefined,
	) {}

	async start(mode: "merge" | "adopt" = "merge"): Promise<void> {
		this.stopped = false;
		this.onStatus("syncing");
		await this.reconcileAndPersist(mode);
		this.openWs();
	}

	/**
	 * Reconcile, then persist the returned cursor **before** anything opens the WS. Ordering is load-bearing:
	 * `connect()` resumes the change bus from `state.lastSeq`, so `lastSeq` must already equal the reconciled
	 * `head` (and `knownServer` the reconciled server set) — else the WS replays pre-snapshot frames (which
	 * can re-materialize a just-removed note) and reconcile can't distinguish new-vs-deleted next time.
	 */
	private async reconcileAndPersist(mode: "merge" | "adopt" = "merge"): Promise<void> {
		const cursor = await this.sink.reconcile(this.state.knownServer, mode);
		this.state.knownServer = cursor.knownServer;
		this.state.lastSeq = cursor.head;
		await this.state.persist();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
		this.ws?.close();
		this.ws = undefined;
		this.onStatus("idle");
	}

	/** Manual full reconcile (the "Sync now" command). */
	async syncNow(): Promise<void> {
		this.onStatus("syncing");
		await this.reconcileAndPersist();
		this.onStatus(this.ws?.readyState === WebSocket.OPEN ? "live" : "offline");
	}

	private openWs(): void {
		if (!this.stopped) void this.connect();
	}

	private async connect(): Promise<void> {
		try {
			const { ticket, url } = await this.api.ticket();
			assertWssUrl(url); // never let a compromised server downgrade the channel to cleartext ws://
			const ws = new WebSocket(
				`${url}?ticket=${encodeURIComponent(ticket)}&since=${this.state.lastSeq}`,
			);
			this.ws = ws;
			ws.addEventListener("open", () => {
				this.onStatus("live");
				void this.sink.drainPending?.(); // came back online → replay any queued offline deletes
			});
			ws.addEventListener("message", (e) => this.onMessage(e.data as string));
			ws.addEventListener("close", (e) => this.scheduleReconnect(closeCode(e)));
			ws.addEventListener("error", () => ws.close());
		} catch {
			this.scheduleReconnect();
		}
	}

	private onMessage(data: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		if (typeof msg !== "object" || msg === null) return;
		const m = msg as { type?: unknown; change?: unknown; changes?: unknown };
		const raw =
			m.type === "change" && m.change
				? [m.change]
				: m.type === "delta" && Array.isArray(m.changes)
					? m.changes
					: [];
		// Validate every frame (safe path, known op) and drop malformed ones — order among survivors is kept.
		const changes: Change[] = [];
		for (const c of raw) {
			const parsed = parseChange(c);
			if (parsed) changes.push(parsed);
		}
		void this.applyInOrder(changes);
	}

	private async applyInOrder(changes: Change[]): Promise<void> {
		for (const change of changes) {
			// Sequential on purpose: routing concurrently could race on the same file.
			// oxlint-disable-next-line no-await-in-loop
			await this.sink.onRemoteChange(change).catch(() => undefined);
		}
	}

	/**
	 * @param code the close code, where the caller saw one. `WS_REAUTH_CLOSE` is the gateway retiring
	 * this socket on schedule — reconnect without telling the user they are offline, because they are
	 * not. Anything else is a genuine drop and keeps the "offline" status it always had.
	 */
	private scheduleReconnect(code?: number): void {
		this.ws = undefined;
		if (this.stopped) return;
		if (code !== WS_REAUTH_CLOSE) this.onStatus("offline");
		this.reconnectTimer = setTimeout(() => this.openWs(), 3000);
	}
}
