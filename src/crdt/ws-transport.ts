import { assertWssUrl } from "../sync/safe-url";
import type { YTransport } from "./crdt-note";

/** Reconnect backoff: base delay, doubled per attempt, capped. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 15000;

/**
 * A `YTransport` over a real WebSocket (Electron/mobile global) to the note's `YNoteDO`. **Auto-reconnects**
 * with capped backoff: on an unintentional drop it re-mints a ticket (they're single-use) and reconnects,
 * and fires `onOpen` so the `CrdtNote` re-sends syncStep1 — the reconnected socket re-syncs, flushing any
 * ops accumulated offline. `close()` is intentional and stops reconnecting. Sends before the socket opens
 * are buffered and flushed on open.
 */
export class WsTransport implements YTransport {
	private ws: WebSocket | undefined;
	private readonly queue: ArrayBuffer[] = [];
	private msgCb: ((d: ArrayBuffer) => void) | undefined;
	private openCb: (() => void) | undefined;
	private closed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private attempt = 0;

	/** @param urlFor mints a fresh ticketed `wss://…/ycrdt/<path>?ticket=…` URL for each (re)connect. */
	constructor(private readonly urlFor: () => Promise<string>) {}

	connect(): void {
		if (!this.closed) void this.doConnect();
	}

	private async doConnect(): Promise<void> {
		if (this.closed) return;
		let url: string;
		try {
			url = await this.urlFor();
			assertWssUrl(url); // reject a downgraded ws:// URL → fail closed to a reconnect
		} catch {
			this.scheduleReconnect();
			return;
		}
		if (this.closed) return;
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.addEventListener("open", () => {
			if (this.closed) {
				ws.close(); // closed while connecting — close cleanly now, no console warning
				return;
			}
			this.attempt = 0;
			for (const m of this.queue) ws.send(m);
			this.queue.length = 0;
			this.openCb?.(); // (re)handshake
		});
		ws.addEventListener("message", (e) => this.msgCb?.(e.data as ArrayBuffer));
		ws.addEventListener("close", () => {
			if (this.ws === ws) this.ws = undefined;
			if (!this.closed) this.scheduleReconnect();
		});
		ws.addEventListener("error", () => ws.close());
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer !== undefined) return;
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_CAP_MS);
		this.attempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.doConnect();
		}, delay);
	}

	send(data: ArrayBuffer): void {
		if (this.closed) return;
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
		else this.queue.push(data);
	}

	onMessage(cb: (d: ArrayBuffer) => void): void {
		this.msgCb = cb;
	}

	onOpen(cb: () => void): void {
		this.openCb = cb;
		if (this.ws?.readyState === WebSocket.OPEN) cb(); // already open (a late subscriber)
	}

	close(): void {
		this.closed = true;
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		const ws = this.ws;
		this.ws = undefined;
		// A still-CONNECTING socket closes cleanly via its own `open` handler (which sees `closed`), avoiding
		// Chromium's "closed before connection established" warning; an open socket closes now.
		if (ws && ws.readyState !== WebSocket.CONNECTING) ws.close();
	}
}
