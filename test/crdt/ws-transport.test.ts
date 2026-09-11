import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsTransport } from "../../src/crdt/ws-transport";

class StubWs {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	readyState = 0; // CONNECTING
	closes = 0;
	binaryType = "";
	private handlers: Record<string, ((e?: unknown) => void)[]> = {};
	constructor(public url: string) {}
	addEventListener(type: string, h: (e?: unknown) => void): void {
		(this.handlers[type] ??= []).push(h);
	}
	emit(type: string, e?: unknown): void {
		for (const h of this.handlers[type] ?? []) h(e);
	}
	open(): void {
		this.readyState = 1;
		this.emit("open");
	}
	close(): void {
		this.closes++;
	}
}

describe("WsTransport", () => {
	let created: StubWs[] = [];
	beforeEach(() => {
		created = [];
		vi.stubGlobal(
			"WebSocket",
			class extends StubWs {
				constructor(url: string) {
					super(url);
					created.push(this);
				}
			},
		);
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("reconnects with a FRESH ticket + re-fires onOpen after an unintentional drop", async () => {
		let ticket = 0;
		const t = new WsTransport(() => Promise.resolve(`wss://x?t=${++ticket}`));
		let opens = 0;
		t.onOpen(() => opens++);
		t.connect();
		await vi.runAllTimersAsync(); // flush the async ticket mint → first socket created
		expect(created).toHaveLength(1);
		created[0]!.open();
		expect(opens).toBe(1);

		created[0]!.emit("close"); // the connection drops unexpectedly
		await vi.advanceTimersByTimeAsync(1000); // backoff → reconnect
		expect(created).toHaveLength(2);
		expect(created[1]!.url).toContain("t=2"); // a fresh single-use ticket
		created[1]!.open();
		expect(opens).toBe(2); // re-handshake fired
	});

	it("refuses a downgraded ws:// URL — no socket is ever constructed", async () => {
		const t = new WsTransport(() => Promise.resolve("ws://insecure/ycrdt"));
		t.connect();
		await Promise.resolve(); // flush urlFor(); assertWssUrl throws → caught → reconnect scheduled (not due)
		await Promise.resolve();
		expect(created).toHaveLength(0);
		t.close(); // stop the backoff timer
	});

	it("stops reconnecting after close()", async () => {
		const t = new WsTransport(() => Promise.resolve("wss://x"));
		t.connect();
		await vi.runAllTimersAsync();
		created[0]!.open();
		t.close(); // intentional
		created[0]!.emit("close");
		await vi.advanceTimersByTimeAsync(30000);
		expect(created).toHaveLength(1); // no reconnect
	});

	it("does NOT close a still-CONNECTING socket directly (no console warning)", async () => {
		const t = new WsTransport(() => Promise.resolve("wss://x"));
		t.connect();
		await vi.runAllTimersAsync();
		const ws = created[0]!;
		ws.readyState = 0; // still CONNECTING
		t.close();
		expect(ws.closes).toBe(0);
		ws.open(); // when it finally opens, it closes cleanly (sees `closed`)
		expect(ws.closes).toBe(1);
	});
});
