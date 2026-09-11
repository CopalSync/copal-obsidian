import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import type { Awareness } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

/**
 * Minimal Yjs sync-protocol framing (the y-websocket wire protocol), shared by every peer — the relay
 * Durable Object, the plugin replica, the agent peer, and tests. Binary messages are `[<type>, <body>]`
 * where type is MSG_SYNC (Yjs document updates) or MSG_AWARENESS (ephemeral presence — remote cursors).
 */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

/** The leading message-type varUint — lets a receiver route sync vs awareness before reading the body. */
export function messageType(data: Uint8Array): number {
	return decoding.readVarUint(decoding.createDecoder(data));
}

/** Exact-length ArrayBuffer of an encoder's bytes. workerd's `WebSocket.send` drops Uint8Array views. */
function frame(encoder: encoding.Encoder): ArrayBuffer {
	const u8 = encoding.toUint8Array(encoder);
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** A syncStep1 (this doc's state vector) that kicks off a sync with a peer. */
export function encodeSyncStep1(doc: Y.Doc): ArrayBuffer {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MSG_SYNC);
	syncProtocol.writeSyncStep1(encoder, doc);
	return frame(encoder);
}

/** Wrap a raw Yjs document update for broadcast to peers. */
export function encodeUpdate(update: Uint8Array): ArrayBuffer {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MSG_SYNC);
	syncProtocol.writeUpdate(encoder, update);
	return frame(encoder);
}

/** Frame an awareness (presence) update for the given clients — `[MSG_AWARENESS, <awareness update>]`. */
export function encodeAwareness(awareness: Awareness, clients: number[]): ArrayBuffer {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MSG_AWARENESS);
	encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
	return frame(encoder);
}

/** Apply an incoming MSG_AWARENESS frame to `awareness` (tagged with `origin` so it isn't echoed back). */
export function applyAwareness(awareness: Awareness, data: Uint8Array, origin: unknown): void {
	const decoder = decoding.createDecoder(data);
	decoding.readVarUint(decoder); // consume the MSG_AWARENESS type byte
	awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), origin);
}

/**
 * Apply an incoming binary message to `doc` (tagged with `origin` so the doc's update handler can avoid
 * echoing it back to its sender), returning an optional reply to send back (e.g. syncStep2 in answer to a
 * syncStep1). Symmetric: the same handler drives both ends of a connection.
 */
export function readMessage(
	doc: Y.Doc,
	data: Uint8Array,
	origin: unknown,
): { reply: ArrayBuffer | null; syncStep2: boolean } {
	const decoder = decoding.createDecoder(data);
	if (decoding.readVarUint(decoder) !== MSG_SYNC) return { reply: null, syncStep2: false };
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MSG_SYNC);
	// readSyncMessage returns the sync sub-type it read; a syncStep2 means the peer sent us its full
	// state → we're now in sync with it (used by the plugin to seed only after the initial sync).
	const syncType = syncProtocol.readSyncMessage(decoder, encoder, doc, origin);
	return {
		// length 1 = just the MSG_SYNC byte, i.e. nothing to reply.
		reply: encoding.length(encoder) > 1 ? frame(encoder) : null,
		syncStep2: syncType === syncProtocol.messageYjsSyncStep2,
	};
}

/** Coerce a WebSocket `message` payload (ArrayBuffer or view) to a Uint8Array. */
export function toBytes(data: ArrayBuffer | ArrayBufferView | string): Uint8Array {
	if (typeof data === "string") return new Uint8Array(0);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
