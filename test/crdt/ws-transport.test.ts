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
		const t = new WsTransport(() => Promise.resolve(`wss://api.copal.uk/ycrdt?t=${++ticket}`));
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

	/**
	 * S7. The other half, and the one the scheme check missed entirely: a perfectly valid `wss://` that
	 * points somewhere else. The ticket endpoint mints this URL, so a compromised or misconfigured one
	 * could send the realtime channel — carrying note text — to a host of its choosing, encrypted and
	 * unremarked. It has to fail closed exactly like the downgrade does.
	 */
	it("refuses a wss:// URL on another host — no socket is ever constructed", async () => {
		const t = new WsTransport(() => Promise.resolve("wss://api.copal.uk.evil.com/ycrdt"));
		t.connect();
		await Promise.resolve();
		await Promise.resolve();
		expect(created, "the socket opened to a host that is not Copal").toHaveLength(0);
		t.close();
	});

	it("stops reconnecting after close()", async () => {
		const t = new WsTransport(() => Promise.resolve("wss://api.copal.uk/ycrdt"));
		t.connect();
		await vi.runAllTimersAsync();
		created[0]!.open();
		t.close(); // intentional
		created[0]!.emit("close");
		await vi.advanceTimersByTimeAsync(30000);
		expect(created).toHaveLength(1); // no reconnect
	});

	it("does NOT close a still-CONNECTING socket directly (no console warning)", async () => {
		const t = new WsTransport(() => Promise.resolve("wss://api.copal.uk/ycrdt"));
		t.connect();
		await vi.runAllTimersAsync();
		const ws = created[0]!;
		ws.readyState = 0; // still CONNECTING
		t.close();
		expect(ws.closes).toBe(0);
		ws.open(); // when it finally opens, it closes cleanly (sees `closed`)
		expect(ws.closes).toBe(1);
	});

	describe("WsTransport — the shared reconnect policy (P8)", () => {
		it("a scheduled retirement comes back on the BASE delay, not the walked-up one", async () => {
			// ⚠️ Walk the backoff up first. Straight after a successful open the counter is 0, so a retirement
			// and an ordinary drop would schedule the same delay and the assertion could not tell them apart.
			// The gateway retires every socket after 30 minutes by design, so a note left open all day must
			// not reach the 15s cap through healthy rotations alone.
			const t = new WsTransport(() => Promise.resolve("wss://api.copal.uk/ycrdt/a.md?ticket=x"));
			t.connect();
			await vi.advanceTimersByTimeAsync(0);
			created.at(-1)?.open();

			for (let i = 0; i < 4; i += 1) {
				created.at(-1)?.emit("close", {}); // ordinary drops, walking the delay up
				await vi.advanceTimersByTimeAsync(20_000);
			}
			const before = created.length;

			created.at(-1)?.emit("close", { code: 4001 }); // WS_REAUTH_CLOSE
			await vi.advanceTimersByTimeAsync(1100); // at most the jittered base delay
			expect(created.length, "a retirement that inherited the backoff would still be waiting").toBe(
				before + 1,
			);
			t.close();
		});

		it("a closed transport does not reconnect", async () => {
			// ⚠️ This proves the `closed` flag, NOT that `close()` releases the Reconnector's
			// online/visibility listeners — removing `reconnector.stop()` leaves this green, because
			// `closed` already blocks the reconnect on its own. The listener release is what stops a
			// transport outliving its note while still listening for `online` (the G5 class of leak), and
			// it is proven where it can be observed: `test/sync/reconnector.test.ts`.
			const t = new WsTransport(() => Promise.resolve("wss://api.copal.uk/ycrdt/a.md?ticket=x"));
			t.connect();
			await vi.advanceTimersByTimeAsync(0);
			created.at(-1)?.open();
			created.at(-1)?.emit("close", {});
			t.close();
			const after = created.length;
			await vi.advanceTimersByTimeAsync(60_000);
			expect(created.length, "a closed transport must not reconnect").toBe(after);
		});
	});
});
