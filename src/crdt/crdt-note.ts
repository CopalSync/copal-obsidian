import { Awareness } from "y-protocols/awareness";
import { colorFromId, colorLightFromId } from "./presence-color";
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
	/** `code` is a WebSocket close code, so a deliberate drop can say why (4002 = unusable frame). */
	close(code?: number): void;
}

/**
 * Inbound frame bounds.
 *
 * A note's whole Yjs state crosses on the first sync, so the ceiling has to clear a large document while
 * still refusing something that is only trying to make us allocate. A frame also has to carry at least a
 * type byte for `messageType` to read.
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MIN_FRAME_BYTES = 1;
/** WebSocket close code for "you sent something I cannot use". In the private-use 4000-4999 range. */
const UNUSABLE_FRAME_CLOSE = 4002;

/** Longest peer display name we will render. Long enough for a name, short enough not to be a banner. */
const MAX_PEER_NAME = 64;

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
	/** Set once a frame could not be used; every later frame from this peer is ignored. */
	private poisoned = false;
	private resolveSynced!: () => void;
	private rejectSynced!: (err: Error) => void;
	private readonly syncedPromise = new Promise<void>((res, rej) => {
		this.resolveSynced = res;
		this.rejectSynced = rej;
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
		/*
		 * ⛔ REGISTERED BEFORE THE RENDERER, AND THAT IS THE WHOLE TRICK.
		 *
		 * yCollab attaches its own awareness listener when the editor binds, which is after this
		 * constructor has run — and y-protocols calls listeners in registration order. So this one
		 * normalises the states map before anything draws from it, rather than a moment too late.
		 */
		this.awareness.on("change", () => this.normaliseRemotePresence());
		// An unobserved rejection is not an error here: a transient peer may be disposed without anyone
		// ever awaiting `whenSynced()`. Marking it handled keeps that from surfacing as a crash.
		void this.syncedPromise.catch(() => undefined);
		transport.onMessage((data) => {
			if (this.poisoned) return; // already gave up on this peer
			const bytes = toBytes(data);
			// Bounds FIRST, so an absurd frame is refused before anything tries to parse it.
			if (bytes.length < MIN_FRAME_BYTES || bytes.length > MAX_FRAME_BYTES) {
				this.poison(`frame out of bounds (${bytes.length} bytes)`);
				return;
			}
			try {
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
			} catch (err) {
				// `readMessage` runs `Y.applyUpdate` on server-supplied bytes. Unguarded, a malformed
				// frame threw INSIDE this listener: nothing caught it, the doc was left part-applied, and
				// `whenSynced()` never settled — which upstream reads as an 8s stall, not as a failure.
				this.poison(`unusable frame (${err instanceof Error ? err.message : String(err)})`);
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
		transport.onOpen(() => {
			// A reconnect is a clean slate: the state vector below re-derives what this peer is missing,
			// so a frame that poisoned the previous socket does not permanently mute the next one.
			this.poisoned = false;
			transport.send(encodeSyncStep1(this.doc));
		});
	}

	/**
	 * Give up on this peer: stop reading from it, tell anyone waiting on the initial sync, and drop the
	 * socket with a code that says why.
	 *
	 * Failing loudly is the point. Carrying on after a frame we could not apply would leave a document
	 * that is neither the server's nor ours, and materialize it over the user's `.md` without a word.
	 */
	private poison(reason: string): void {
		this.poisoned = true;
		this.rejectSynced(new Error(`sync aborted: ${reason}`));
		this.transport.close(UNUSABLE_FRAME_CLOSE);
	}

	/** Resolves once the initial sync with the DO completes — so an empty doc reliably means "not on the
	 *  server" (the seed logic uses this to avoid double-seeding). */
	whenSynced(): Promise<void> {
		return this.syncedPromise;
	}

	/**
	 * Overwrite every REMOTE peer's presentation with values we derived ourselves.
	 *
	 * The Durable Object relays awareness frames verbatim and yCollab renders `user.color` and
	 * `colorLight` straight into inline `style` attributes on the caret widget and selection marks — in
	 * the *other* person's editor. A peer already authorized on the note (a second device, or an agent)
	 * could therefore put arbitrary text into a style attribute someone else's browser parses.
	 *
	 * Normalising the value was the other option; deriving it is stronger, because there is then nothing
	 * to get the sanitiser wrong about. The colour is ours to choose and a stable function of the client
	 * id, so peers stay distinguishable without being able to say how. Our own state is left alone.
	 */
	private normaliseRemotePresence(): void {
		const mine = this.awareness.clientID;
		for (const [clientId, state] of this.awareness.getStates()) {
			if (clientId === mine) continue;
			const user = (state as { user?: Record<string, unknown> }).user;
			if (user === undefined) continue;
			user.color = colorFromId(clientId);
			user.colorLight = colorLightFromId(clientId);
			user.name =
				typeof user.name === "string" ? user.name.slice(0, MAX_PEER_NAME) : "Someone else";
		}
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
