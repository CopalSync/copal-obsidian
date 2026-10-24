import type { SyncStatus } from "../ui/status";
import { ApiError, type Change, type SyncApi } from "./api";
import { Reconnector } from "./reconnector";
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
 *
 * Three properties the frames rely on, all of them P5:
 *
 *  1. **One queue.** Every frame joins a single serialized chain. `onMessage` used to fire
 *     `void applyInOrder(...)` per message, so each batch was internally sequential while the BATCHES
 *     overlapped — two messages could route changes for the same path concurrently.
 *  2. **`lastSeq` is a LOW-WATER mark**, advanced per applied frame and persisted once per message. It
 *     only moved at reconcile before, so every reconnect asked for everything since the last full
 *     reconcile — on a long session, the whole journal. It never passes a frame that failed to apply:
 *     at-least-once on reconnect beats silently losing a change, and a reconcile is the repair.
 *  3. **Own echoes are filtered.** The gateway stamps `plugin:<device>` so the originating device can
 *     drop them (`ChangeRecord.origin` documents that as a published contract). ⚠️ A filtered frame
 *     must STILL advance the cursor, or the low-water mark stalls on our own write for ever and every
 *     reconnect replays from there — the filter would become a worse version of the bug it fixes.
 *     ⚠️ `"crdt"` is never filtered: attribution falls back to it when the note's DO is evicted between
 *     the apply and its materialize alarm, so a `"crdt"` frame may be ours or another device's. Routing
 *     our own again is idempotent; dropping someone else's is not.
 */
export class SyncClient {
	private ws: WebSocket | undefined;
	private stopped = true;
	/**
	 * The one reconnect policy (ROADMAP P8). This used to be a FLAT 3s retry with no backoff at all, so a
	 * server having a bad minute was hammered once every three seconds by every client it had.
	 */
	private readonly reconnector = new Reconnector({
		baseMs: 1000,
		capMs: 15000,
		connect: () => this.openWs(),
		onAuthFailure: () => {
			// Nothing here can fix a refused credential, and looping on it makes the client look broken
			// rather than signed out. Surface it and stop.
			this.onStatus("offline");
		},
	});
	/** The single chain every frame batch joins, so batches cannot interleave their awaits. */
	private chain: Promise<void> = Promise.resolve();
	/**
	 * Set when a frame failed to apply. While it is set the cursor stops advancing, so everything from
	 * the failure onwards is replayed on the next connect. Cleared by a reconcile, which is the repair.
	 */
	private stalled = false;

	constructor(
		private readonly api: SyncApi,
		private readonly sink: RemoteSink,
		private readonly state: SyncState,
		private readonly onStatus: (s: SyncStatus) => void = () => undefined,
		/** This install's id, for the echo filter. A function because `main.ts` loads it asynchronously. */
		private readonly deviceId: () => string = () => "",
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
		// A full reconcile is the authority on where the client is, so it clears any stall: everything
		// up to `head` is accounted for whether or not an individual frame failed earlier.
		this.stalled = false;
		await this.state.persist();
	}

	stop(): void {
		this.stopped = true;
		this.reconnector.stop();
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
			/*
			 * ⛔ Re-checked AFTER the await, because `stop()` could not have closed a socket that did not
			 * exist yet: it ran while `this.ws` was still undefined. Opening one now leaves a live channel
			 * on a credential the user has just signed out of and revoked, and nothing would ever close it
			 * — `scheduleReconnect` bails on `stopped`, so not even a drop brings it back through here.
			 */
			if (this.stopped) return;
			assertWssUrl(url); // never let a compromised server downgrade the channel to cleartext ws://
			const ws = new WebSocket(
				`${url}?ticket=${encodeURIComponent(ticket)}&since=${this.state.lastSeq}`,
			);
			this.ws = ws;
			ws.addEventListener("open", () => {
				this.reconnector.succeeded();
				this.onStatus("live");
				void this.sink.drainPending?.(); // came back online → replay any queued offline deletes
			});
			ws.addEventListener("message", (e) => this.onMessage(e.data as string));
			ws.addEventListener("close", (e) => this.scheduleReconnect(closeCode(e)));
			ws.addEventListener("error", () => ws.close());
		} catch (err) {
			// A refused ticket is an auth problem, not a network one: retrying cannot mint a valid ticket
			// from an invalid credential.
			if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
				this.reconnector.authFailed();
				return;
			}
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
		// Join the one chain rather than starting a new async run per message.
		this.chain = this.chain.then(() => this.applyInOrder(changes));
	}

	private async applyInOrder(changes: Change[]): Promise<void> {
		const device = this.deviceId();
		// An unknown device id must not match anything: `plugin:` alone would filter every device's
		// frames, which is silent data loss rather than a missing optimisation.
		const mine = device === "" ? null : `plugin:${device}`;
		let advanced = false;

		for (const change of changes) {
			if (mine !== null && change.origin === mine) {
				// Already applied here — it is our own write coming back. Advance anyway (see note 3).
				if (this.advance(change.seq)) advanced = true;
				continue;
			}
			try {
				// Sequential on purpose: routing concurrently could race on the same file.
				// oxlint-disable-next-line no-await-in-loop
				await this.sink.onRemoteChange(change);
				if (this.advance(change.seq)) advanced = true;
			} catch {
				// Keep routing the rest — one bad frame must not stop the bus — but stop the cursor here.
				this.stalled = true;
			}
		}

		// One write per message, not per frame: P1 raised the downstream rate to ~60 notes/sec, and a
		// `data.json` write each would dwarf the work it is recording.
		if (advanced) await this.state.persist();
	}

	/** Move the low-water mark, unless a frame has failed or this one is older than where we are. */
	private advance(seq: number): boolean {
		if (this.stalled || seq <= this.state.lastSeq) return false;
		this.state.lastSeq = seq;
		return true;
	}

	/**
	 * @param code the close code, where the caller saw one. `WS_REAUTH_CLOSE` is the gateway retiring
	 * this socket on schedule — reconnect without telling the user they are offline, because they are
	 * not. Anything else is a genuine drop and keeps the "offline" status it always had.
	 */
	private scheduleReconnect(code?: number): void {
		this.ws = undefined;
		if (this.stopped) return;
		if (code === WS_REAUTH_CLOSE) this.reconnector.scheduledRetirement();
		else this.onStatus("offline");
		this.reconnector.schedule();
	}
}
