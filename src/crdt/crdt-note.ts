import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
	applyAwareness,
	encodeAwareness,
	encodeSyncStep1,
	encodeUpdate,
	MSG_AWARENESS,
	messageType,
	readMessage,
	toBytes,
} from "./y-sync";

/** A duplex binary transport — a WebSocket in production, a paired in-memory stub in tests. */
export interface YTransport {
	send(data: ArrayBuffer): void;
	onMessage(cb: (data: ArrayBuffer | Uint8Array) => void): void;
	/** Fires on every (re)connect — the peer re-sends its syncStep1 so a reconnected socket re-syncs. */
	onOpen(cb: () => void): void;
	close(): void;
}

/**
 * A per-note CRDT replica: a `Y.Doc` synced with the note's `YNoteDO` over an injected binary transport,
 * running the **same** y-sync protocol as the gateway. Obsidian-free (main.ts supplies a WebSocket
 * transport); the FileBridge (P1.5) mirrors `Y.Text` ⇄ the `.md` file. The agent and the human are the
 * same kind of peer — both just drive one of these against the shared doc.
 */
export class CrdtNote {
	readonly doc: Y.Doc;
	/** Presence for the CM6 binding. Local-only until awareness is relayed over the WS. */
	readonly awareness: Awareness;
	private readonly ytext: Y.Text;
	/** Whether we created the doc (and must destroy it) — false when a persisted `LocalDocStore` doc is injected. */
	private readonly ownsDoc: boolean;
	private synced = false;
	private resolveSynced!: () => void;
	private readonly syncedPromise = new Promise<void>((res) => {
		this.resolveSynced = res;
	});

	/**
	 * @param transport duplex binary transport to the note's `YNoteDO`.
	 * @param doc an existing **persisted** Y.Doc (local-first) whose offline history syncs on connect;
	 *   omitted → a fresh in-memory doc (a transient/agent peer).
	 */
	constructor(
		private readonly transport: YTransport,
		doc?: Y.Doc,
	) {
		this.doc = doc ?? new Y.Doc();
		this.ownsDoc = doc === undefined;
		this.awareness = new Awareness(this.doc);
		this.ytext = this.doc.getText("content");
		transport.onMessage((data) => {
			const bytes = toBytes(data);
			if (messageType(bytes) === MSG_AWARENESS) {
				applyAwareness(this.awareness, bytes, transport); // remote presence → local Awareness
				return;
			}
			const { reply, syncStep2 } = readMessage(this.doc, bytes, transport);
			if (reply) transport.send(reply);
			if (syncStep2 && !this.synced) {
				// The server sent its full state — the initial sync is complete.
				this.synced = true;
				this.resolveSynced();
			}
		});
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== transport) transport.send(encodeUpdate(update)); // don't echo a remote apply
		});
		// Relay local presence changes (cursor/user) to peers; skip a change we just applied from a peer.
		this.awareness.on(
			"update",
			(changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
				if (origin === transport) return;
				const clients = [...changes.added, ...changes.updated, ...changes.removed];
				transport.send(encodeAwareness(this.awareness, clients));
			},
		);
		// (Re)handshake on every (re)connect — so after a reconnect the socket re-syncs (offline ops flush).
		transport.onOpen(() => transport.send(encodeSyncStep1(this.doc)));
	}

	/** Resolves once the initial sync with the DO completes — so an empty doc reliably means "not on the
	 *  server" (the seed logic uses this to avoid double-seeding). */
	whenSynced(): Promise<void> {
		return this.syncedPromise;
	}

	/** The current note text. */
	text(): string {
		return this.ytext.toString();
	}

	/** Apply a local edit (from the file bridge or the editor); tagged `"local"` so the bridge can tell. */
	edit(fn: (t: Y.Text) => void): void {
		this.doc.transact(() => fn(this.ytext), "local");
	}

	/** Subscribe to any change; the callback gets the update's origin (`"local"`, the transport, or null). */
	onChange(cb: (origin: unknown) => void): () => void {
		const handler = (_u: Uint8Array, origin: unknown): void => cb(origin);
		this.doc.on("update", handler);
		return () => this.doc.off("update", handler);
	}

	disconnect(): void {
		// Broadcast a presence-clear to peers BEFORE the socket closes (the update relay above sends it), so
		// they drop our caret immediately instead of waiting ~30s for yCollab's outdatedTimeout. Explicit and
		// ordered — not left to rely on `awareness.destroy()`'s internal `setLocalState(null)` firing in time.
		this.awareness.setLocalState(null);
		this.awareness.destroy(); // then clear the presence heartbeat interval + local state
		this.transport.close();
		if (this.ownsDoc) this.doc.destroy(); // a persisted (injected) doc is owned by LocalDocStore
	}
}
