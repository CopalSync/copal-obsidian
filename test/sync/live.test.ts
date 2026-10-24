import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Change, type SyncApi } from "../../src/sync/api";
import { type RemoteSink, SyncClient } from "../../src/sync/live";
import { type SyncData, SyncState } from "../../src/sync/state";

type Cursor = { knownServer: string[]; head: number };

class StubWs {
	static OPEN = 1;
	readyState = 1;
	private handlers: Record<string, ((e: unknown) => void)[]> = {};
	constructor(public url: string) {}
	addEventListener(type: string, h: (e: unknown) => void): void {
		(this.handlers[type] ??= []).push(h);
	}
	emit(type: string, e: unknown): void {
		for (const h of this.handlers[type] ?? []) h(e);
	}
	close(): void {}
}

describe("SyncClient", () => {
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
	});
	afterEach(() => vi.unstubAllGlobals());

	function make(
		sink: RemoteSink,
		onSave?: (d: SyncData) => void,
		ticket: () => Promise<{ ticket: string; url: string }> = () =>
			Promise.resolve({ ticket: "t", url: "wss://api.copal.uk/sync" }),
		deviceId = "",
	): SyncClient {
		const api = { ticket } as unknown as SyncApi;
		/*
		 * A hand-rolled slice rather than a real one, because these tests are about WHEN the cursor
		 * reaches storage relative to the socket opening, and the spy is the observation point. It
		 * copies on set exactly as the real slice does — recording the live object would let a later
		 * mutation rewrite what an earlier save is remembered as having contained.
		 */
		let stored: SyncData | undefined = { lastSeq: 0, knownServer: [] };
		const state = new SyncState({
			get: () => stored,
			set: (d: SyncData) => {
				stored = JSON.parse(JSON.stringify(d)) as SyncData;
				onSave?.(stored);
				return Promise.resolve();
			},
		});
		return new SyncClient(
			api,
			sink,
			state,
			() => undefined,
			() => deviceId,
		);
	}

	it("reconciles on start and routes each change frame to the sink, in order", async () => {
		const reconcile = vi
			.fn<(k?: readonly string[]) => Promise<Cursor>>()
			.mockResolvedValue({ knownServer: [], head: 0 });
		const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
		const client = make({ reconcile, onRemoteChange });
		await client.start();
		expect(reconcile).toHaveBeenCalledOnce();
		await Promise.resolve();
		await Promise.resolve();
		const ws = created[0]!;
		ws.emit("message", {
			data: JSON.stringify({
				type: "change",
				change: { seq: 3, path: "b.md", op: "put", origin: "crdt", ts: 1 },
			}),
		});
		ws.emit("message", {
			data: JSON.stringify({
				type: "delta",
				changes: [{ seq: 4, path: "c.md", op: "put", origin: "agent", ts: 1 }],
			}),
		});
		// ⚠️ Not a fixed number of microtasks: frames now share ONE queue (P5), so the second batch
		// starts only after the first has finished, including its cursor write. Wait for the outcome.
		await vi.waitFor(() => {
			const paths = onRemoteChange.mock.calls.map((c) => (c[0] as Change).path);
			expect(paths).toEqual(["b.md", "c.md"]);
		});
	});

	it("drops a malformed change frame but keeps valid ones in order", async () => {
		const reconcile = vi
			.fn<(k?: readonly string[]) => Promise<Cursor>>()
			.mockResolvedValue({ knownServer: [], head: 0 });
		const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
		const client = make({ reconcile, onRemoteChange });
		await client.start();
		await Promise.resolve();
		await Promise.resolve();
		created[0]!.emit("message", {
			data: JSON.stringify({
				type: "delta",
				changes: [
					{ seq: 1, path: "a.md", op: "put", origin: "x", ts: 1 },
					{ seq: 2, path: "../evil.md", op: "put", origin: "x", ts: 1 }, // traversal → dropped
					{ seq: 3, path: "c.md", op: "frob", origin: "x", ts: 1 }, // bad op → dropped
					{ seq: 4, path: "d.md", op: "delete", origin: "x", ts: 1 },
				],
			}),
		});
		await Promise.resolve();
		await Promise.resolve();
		const paths = onRemoteChange.mock.calls.map((c) => (c[0] as Change).path);
		expect(paths).toEqual(["a.md", "d.md"]);
	});

	it("refuses a downgraded ws:// ticket URL — no socket, goes offline", async () => {
		const statuses: string[] = [];
		const api = {
			ticket: () => Promise.resolve({ ticket: "t", url: "ws://x/sync" }),
		} as unknown as SyncApi;
		const state = new SyncState({
			get: () => ({ lastSeq: 0, knownServer: [] }),
			set: () => Promise.resolve(),
		});
		const reconcile = vi
			.fn<(k?: readonly string[]) => Promise<Cursor>>()
			.mockResolvedValue({ knownServer: [], head: 0 });
		const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
		const client = new SyncClient(api, { reconcile, onRemoteChange }, state, (s) =>
			statuses.push(s),
		);
		await client.start();
		await Promise.resolve();
		await Promise.resolve();
		expect(created).toHaveLength(0); // assertWssUrl threw → no WebSocket constructed
		expect(statuses).toContain("offline");
		client.stop(); // clear the pending reconnect timer
	});

	it("start(mode) threads the mode to reconcile; syncNow always merges (never trashes)", async () => {
		const reconcile = vi
			.fn<(k?: readonly string[], mode?: "merge" | "adopt") => Promise<Cursor>>()
			.mockResolvedValue({ knownServer: [], head: 0 });
		const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
		const client = make({ reconcile, onRemoteChange });
		await client.start("adopt");
		expect(reconcile).toHaveBeenLastCalledWith([], "adopt");
		await client.syncNow();
		expect(reconcile).toHaveBeenLastCalledWith([], "merge");
	});

	it("drains pending mutations when the WS opens (came-back-online replay)", async () => {
		const reconcile = vi
			.fn<(k?: readonly string[]) => Promise<Cursor>>()
			.mockResolvedValue({ knownServer: [], head: 0 });
		const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
		const drainPending = vi.fn<() => Promise<void>>().mockResolvedValue();
		const client = make({ reconcile, onRemoteChange, drainPending });
		await client.start();
		await Promise.resolve();
		await Promise.resolve();
		created[0]!.emit("open", {}); // the socket (re)connected
		await Promise.resolve();
		expect(drainPending).toHaveBeenCalled(); // queued offline deletes replay now
	});

	it("persists the reconcile cursor (knownServer + lastSeq=head) BEFORE opening the WS", async () => {
		const saved: SyncData[] = [];
		const reconcile = vi
			.fn<(k?: readonly string[]) => Promise<Cursor>>()
			.mockResolvedValue({ knownServer: ["a.md"], head: 9 });
		const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
		const client = make({ reconcile, onRemoteChange }, (d) => saved.push(d));
		await client.start();
		await Promise.resolve();
		await Promise.resolve();
		// Reconcile was handed the persisted knownServer, and the WS resumes from the reconciled head — which
		// only holds if the cursor was persisted before openWs (else `since` would be the stale value).
		expect(reconcile).toHaveBeenCalledWith([], "merge");
		expect(created[0]!.url).toContain("since=9");
		expect(saved.at(-1)).toEqual({ lastSeq: 9, knownServer: ["a.md"] });
	});

	/**
	 * ⛔ The other half of the sign-out race. `stop()` runs while the ticket is still in flight, so
	 * `this.ws` is undefined and there is nothing for it to close; without a re-check the socket opens
	 * afterwards, on a credential that has just been revoked, and nothing ever closes it —
	 * `scheduleReconnect` bails on `stopped`, so not even a drop brings it back through `connect`.
	 */
	it("opens no socket when stop() lands while the ticket is still in flight", async () => {
		let release!: (t: { ticket: string; url: string }) => void;
		const pending = new Promise<{ ticket: string; url: string }>((res) => {
			release = res;
		});
		const client = make(
			{
				reconcile: vi.fn().mockResolvedValue({ knownServer: [], head: 0 }),
				onRemoteChange: vi.fn().mockResolvedValue(undefined),
			},
			undefined,
			() => pending,
		);

		await client.start();
		client.stop();
		release({ ticket: "t", url: "wss://api.copal.uk/sync" });
		await Promise.resolve();
		await Promise.resolve();

		expect(created).toHaveLength(0);
	});

	// ── P5 ────────────────────────────────────────────────────────────────────────────────────────

	/** A frame as the journal sends it. `origin` is what lets a device filter its own echoes. */
	function frame(seq: number, path: string, origin = "crdt"): Change {
		return { seq, path, op: "put", origin, ts: 0 } as Change;
	}

	function deltaOf(...changes: Change[]): { data: string } {
		return { data: JSON.stringify({ type: "delta", changes }) };
	}

	describe("the cursor is a low-water mark, advanced per applied frame", () => {
		it("advances lastSeq as frames land, so a reconnect does not replay the journal", async () => {
			// ⛔ The bug: lastSeq only moved at reconcile, so every reconnect asked the server for
			// everything since the last full reconcile — on a long-lived session, the whole journal.
			const saves: SyncData[] = [];
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 10 }),
					onRemoteChange: () => Promise.resolve(),
				},
				(d) => saves.push(d),
			);
			await client.start();
			created[0]?.emit("message", deltaOf(frame(11, "a.md"), frame(12, "b.md")));
			await vi.waitFor(() => expect(saves.at(-1)?.lastSeq).toBe(12));
		});

		it("asks the server only for what it has not applied, on reconnect", async () => {
			const saves: SyncData[] = [];
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 10 }),
					onRemoteChange: () => Promise.resolve(),
				},
				(d) => saves.push(d),
			);
			await client.start();
			expect(created[0]?.url).toMatch(/since=10/);
			created[0]?.emit("message", deltaOf(frame(11, "a.md"), frame(12, "b.md")));
			await vi.waitFor(() => expect(saves.at(-1)?.lastSeq).toBe(12));

			// Fake timers only for the backoff, and only after the awaiting above is done — mixing them
			// with `waitFor` makes the wait itself depend on the clock being advanced.
			vi.useFakeTimers();
			try {
				created[0]?.emit("close", {});
				await vi.advanceTimersByTimeAsync(3100);
			} finally {
				vi.useRealTimers();
			}
			await vi.waitFor(() => expect(created.length).toBe(2));
			expect(created[1]?.url, "the reconnect resumes from 12, not from 10").toMatch(/since=12/);
		});

		it("does NOT advance past a frame that failed to apply", async () => {
			// ⛔ The low-water property. If frame 11 fails and 12 succeeds, the cursor must stay at 10:
			// advancing to 12 would lose 11 for good. At-least-once beats silently dropping a change.
			const saves: SyncData[] = [];
			const onRemoteChange = vi.fn((c: Change) =>
				c.seq === 11 ? Promise.reject(new Error("write failed")) : Promise.resolve(),
			);
			const client = make(
				{ reconcile: () => Promise.resolve({ knownServer: [], head: 10 }), onRemoteChange },
				(d) => saves.push(d),
			);
			await client.start();
			created[0]?.emit("message", deltaOf(frame(11, "a.md"), frame(12, "b.md")));
			await vi.waitFor(() => expect(onRemoteChange).toHaveBeenCalledTimes(2));
			expect(saves.at(-1)?.lastSeq, "the cursor cannot pass an unapplied frame").toBe(10);
		});

		it("still applies later frames after one fails, rather than stopping the bus", async () => {
			const onRemoteChange = vi.fn((c: Change) =>
				c.seq === 11 ? Promise.reject(new Error("transient")) : Promise.resolve(),
			);
			const client = make({
				reconcile: () => Promise.resolve({ knownServer: [], head: 10 }),
				onRemoteChange,
			});
			await client.start();
			created[0]?.emit("message", deltaOf(frame(11, "a.md"), frame(12, "b.md"), frame(13, "c.md")));
			await vi.waitFor(() => expect(onRemoteChange).toHaveBeenCalledTimes(3));
		});

		it("a reconcile repairs a stalled cursor", async () => {
			const saves: SyncData[] = [];
			const onRemoteChange = vi.fn((c: Change) =>
				c.seq === 11 ? Promise.reject(new Error("x")) : Promise.resolve(),
			);
			let head = 10;
			const client = make(
				{ reconcile: () => Promise.resolve({ knownServer: [], head }), onRemoteChange },
				(d) => saves.push(d),
			);
			await client.start();
			created[0]?.emit("message", deltaOf(frame(11, "a.md")));
			await vi.waitFor(() => expect(onRemoteChange).toHaveBeenCalled());
			expect(saves.at(-1)?.lastSeq).toBe(10);

			head = 20;
			await client.syncNow();
			expect(saves.at(-1)?.lastSeq, "a full reconcile is the repair").toBe(20);
			created[0]?.emit("message", deltaOf(frame(21, "b.md")));
			await vi.waitFor(() => expect(saves.at(-1)?.lastSeq).toBe(21));
		});

		it("never moves the cursor backwards", async () => {
			// ⚠️ Waiting on `saves.length > 0` here would be VACUOUS — the reconcile's own write already
			// satisfies it, so the assertion could run before the stale frame was ever applied, and it
			// did: a mutation letting `advance` go backwards stayed green. Wait for the FRAME instead.
			const saves: SyncData[] = [];
			const applied: number[] = [];
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 50 }),
					onRemoteChange: (c) => {
						applied.push(c.seq);
						return Promise.resolve();
					},
				},
				(d) => saves.push(d),
			);
			await client.start();
			created[0]?.emit("message", deltaOf(frame(7, "old.md")));
			await vi.waitFor(() => expect(applied).toEqual([7]));
			// Give any (incorrect) cursor write a turn to land before asserting it did not happen.
			await Promise.resolve();
			expect(saves.at(-1)?.lastSeq, "a stale frame must not rewind the cursor").toBe(50);
		});

		it("writes the cursor once per message, not once per frame", async () => {
			// A write per frame is a data.json write per frame; P1 raised the downstream rate to ~60
			// notes/sec, so that would be 60 writes a second.
			const saves: SyncData[] = [];
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 0 }),
					onRemoteChange: () => Promise.resolve(),
				},
				(d) => saves.push(d),
			);
			await client.start();
			const before = saves.length;
			created[0]?.emit(
				"message",
				deltaOf(frame(1, "a.md"), frame(2, "b.md"), frame(3, "c.md"), frame(4, "d.md")),
			);
			await vi.waitFor(() => expect(saves.at(-1)?.lastSeq).toBe(4));
			expect(saves.length - before, "one batch, one write").toBe(1);
		});
	});

	describe("frames feed one queue", () => {
		it("a message arriving mid-apply waits, instead of interleaving with the one in flight", async () => {
			// ⛔ `onMessage` used to fire `void applyInOrder(...)` per message, so two messages could
			// interleave their awaits and route two changes for the same path concurrently. Each batch
			// was internally sequential; the batches were not.
			const order: string[] = [];
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const onRemoteChange = vi.fn(async (c: Change) => {
				order.push(`start:${c.seq}`);
				if (c.seq === 1) await gate;
				order.push(`end:${c.seq}`);
			});
			const client = make({
				reconcile: () => Promise.resolve({ knownServer: [], head: 0 }),
				onRemoteChange,
			});
			await client.start();
			created[0]?.emit("message", deltaOf(frame(1, "a.md")));
			created[0]?.emit("message", deltaOf(frame(2, "a.md")));
			await vi.waitFor(() => expect(order).toEqual(["start:1"]));
			release();
			await vi.waitFor(() => expect(order.length).toBe(4));
			expect(order, "the second message must not start before the first finishes").toEqual([
				"start:1",
				"end:1",
				"start:2",
				"end:2",
			]);
		});
	});

	describe("the echo filter", () => {
		it("skips a frame this device originated", async () => {
			// The gateway stamps `plugin:<device>` precisely so the originating device can filter its
			// own echoes — `ChangeRecord.origin` documents that as a published contract. Our own write
			// is already applied locally, so routing it back is a wasted round trip at best.
			const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
			const client = make(
				{ reconcile: () => Promise.resolve({ knownServer: [], head: 0 }), onRemoteChange },
				undefined,
				undefined,
				"dev-1",
			);
			await client.start();
			created[0]?.emit("message", deltaOf(frame(1, "mine.md", "plugin:dev-1")));
			await vi.waitFor(() => expect(created.length).toBe(1));
			await Promise.resolve();
			expect(onRemoteChange).not.toHaveBeenCalled();
		});

		it("STILL advances the cursor past its own echo", async () => {
			// ⛔ The interaction between the two halves. Skipping the frame without advancing would
			// stall the low-water mark on our own write for ever, and every reconnect would replay
			// from there — turning the echo filter into a worse version of the bug it fixes.
			const saves: SyncData[] = [];
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 0 }),
					onRemoteChange: () => Promise.resolve(),
				},
				(d) => saves.push(d),
				undefined,
				"dev-1",
			);
			await client.start();
			created[0]?.emit("message", deltaOf(frame(1, "mine.md", "plugin:dev-1")));
			await vi.waitFor(() => expect(saves.at(-1)?.lastSeq).toBe(1));
		});

		it("does NOT skip another device's frame, nor a crdt-attributed one", async () => {
			// ⚠️ `plugin:<device>` attribution falls back to "crdt" when the DO is evicted between the
			// apply and its alarm, so "crdt" must always be processed — it may be our own write, and
			// re-applying is idempotent. Dropping it would lose another device's change.
			const seen: number[] = [];
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 0 }),
					onRemoteChange: (c) => {
						seen.push(c.seq);
						return Promise.resolve();
					},
				},
				undefined,
				undefined,
				"dev-1",
			);
			await client.start();
			created[0]?.emit(
				"message",
				deltaOf(
					frame(1, "theirs.md", "plugin:dev-2"),
					frame(2, "agent.md", "agent"),
					frame(3, "batched.md", "crdt"),
					frame(4, "mine.md", "plugin:dev-1"),
				),
			);
			await vi.waitFor(() => expect(seen).toEqual([1, 2, 3]));
		});

		it("filters nothing when the device id is not known yet", async () => {
			// An empty device id must not accidentally match `plugin:` frames.
			const onRemoteChange = vi.fn<(c: Change) => Promise<void>>().mockResolvedValue();
			const client = make({
				reconcile: () => Promise.resolve({ knownServer: [], head: 0 }),
				onRemoteChange,
			});
			await client.start();
			created[0]?.emit("message", deltaOf(frame(1, "x.md", "plugin:")));
			await vi.waitFor(() => expect(onRemoteChange).toHaveBeenCalledTimes(1));
		});
	});

	describe("P12 — a reconnect replays only what was missed", () => {
		it("resumes from the applied cursor and routes only the frames it had not seen", async () => {
			// ⛔ The row P12 could not write before P5. The property is end-to-end: what the client ASKS
			// for on reconnect, and what the sink is handed as a result. Before P5 the cursor only moved
			// at reconcile, so a reconnect asked for everything since the last full reconcile and the
			// sink re-processed every frame in between.
			const applied: number[] = [];
			const saves: SyncData[] = [];
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 100 }),
					onRemoteChange: (c) => {
						applied.push(c.seq);
						return Promise.resolve();
					},
				},
				(d) => saves.push(d),
			);
			await client.start();
			expect(created[0]?.url).toMatch(/since=100/);

			// Live session: three frames land.
			created[0]?.emit(
				"message",
				deltaOf(frame(101, "a.md"), frame(102, "b.md"), frame(103, "c.md")),
			);
			await vi.waitFor(() => expect(saves.at(-1)?.lastSeq).toBe(103));
			expect(applied).toEqual([101, 102, 103]);

			// The socket drops and comes back.
			vi.useFakeTimers();
			try {
				created[0]?.emit("close", {});
				await vi.advanceTimersByTimeAsync(3100);
			} finally {
				vi.useRealTimers();
			}
			await vi.waitFor(() => expect(created.length).toBe(2));
			expect(
				created[1]?.url,
				"the server is asked for 104 onwards — not the whole journal since the reconcile",
			).toMatch(/since=103/);

			// The server honours the cursor and sends only what was missed.
			created[1]?.emit("message", deltaOf(frame(104, "d.md")));
			await vi.waitFor(() => expect(saves.at(-1)?.lastSeq).toBe(104));
			expect(applied, "nothing already applied is routed a second time").toEqual([
				101, 102, 103, 104,
			]);
		});

		it("replays from the last APPLIED frame, not the last received one", async () => {
			// If 102 fails, the cursor stays at 101 and the reconnect asks for 102 again — the frame is
			// retried rather than lost. That is the whole point of a low-water mark.
			const saves: SyncData[] = [];
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 100 }),
					onRemoteChange: (c) =>
						c.seq === 102 ? Promise.reject(new Error("disk full")) : Promise.resolve(),
				},
				(d) => saves.push(d),
			);
			await client.start();
			created[0]?.emit(
				"message",
				deltaOf(frame(101, "a.md"), frame(102, "b.md"), frame(103, "c.md")),
			);
			await vi.waitFor(() => expect(saves.at(-1)?.lastSeq).toBe(101));

			vi.useFakeTimers();
			try {
				created[0]?.emit("close", {});
				await vi.advanceTimersByTimeAsync(3100);
			} finally {
				vi.useRealTimers();
			}
			await vi.waitFor(() => expect(created.length).toBe(2));
			expect(created[1]?.url, "the failed frame is asked for again").toMatch(/since=101/);
		});
	});

	describe("P8 — the reconnect policy", () => {
		it("stops reconnecting when the ticket is REFUSED, rather than looping on a dead credential", async () => {
			// ⛔ A 401 does not get better by being retried: the credential is the problem, and nothing at
			// this layer can mint a valid ticket from an invalid one. Looping every 3s for ever made a
			// signed-out client look broken instead of signed out.
			// ⚠️ Asserting "no socket was opened" would be VACUOUS: a retried 401 never opens one either.
			// What distinguishes stopping from looping is how many times the TICKET was asked for.
			const statuses: string[] = [];
			let ticketCalls = 0;
			const api = {
				ticket: () => {
					ticketCalls += 1;
					return Promise.reject(new ApiError(401, "unauthorized"));
				},
			} as unknown as SyncApi;
			let stored: SyncData | undefined = { lastSeq: 0, knownServer: [] };
			const state = new SyncState({
				get: () => stored,
				set: (d: SyncData) => {
					stored = d;
					return Promise.resolve();
				},
			});
			const client = new SyncClient(
				api,
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 0 }),
					onRemoteChange: () => Promise.resolve(),
				},
				state,
				(st) => statuses.push(st),
			);
			vi.useFakeTimers();
			try {
				await client.start();
				await vi.advanceTimersByTimeAsync(120_000);
			} finally {
				vi.useRealTimers();
			}
			expect(ticketCalls, "it must ask ONCE and stop, not loop on a dead credential").toBe(1);
			expect(created.length).toBe(0);
			expect(statuses.at(-1)).toBe("offline");
		});

		it("keeps retrying an ordinary network failure", async () => {
			let calls = 0;
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 0 }),
					onRemoteChange: () => Promise.resolve(),
				},
				undefined,
				() => {
					calls += 1;
					return Promise.reject(new Error("ECONNRESET"));
				},
			);
			// ⚠️ Fake timers BEFORE start(): the first failure schedules its retry during start(), so
			// installing them afterwards leaves that timer on the real clock and advancing does nothing.
			vi.useFakeTimers();
			try {
				await client.start();
				expect(calls).toBe(1);
				await vi.advanceTimersByTimeAsync(60_000);
			} finally {
				vi.useRealTimers();
			}
			expect(calls, "a network blip must keep being retried").toBeGreaterThan(1);
		});

		it("a scheduled retirement does not inherit the backoff", async () => {
			// The gateway caps every socket at 30 minutes and closes it with WS_REAUTH_CLOSE. That is
			// healthy, so it must not walk the delay up — nor flash "offline" at the user.
			const statuses: string[] = [];
			const client = make(
				{
					reconcile: () => Promise.resolve({ knownServer: [], head: 0 }),
					onRemoteChange: () => Promise.resolve(),
				},
				undefined,
				undefined,
				"",
			);
			void statuses;
			vi.useFakeTimers();
			try {
				await client.start();
				// ⚠️ Walk the backoff UP first. Straight after a successful open the attempt counter is
				// already 0, so a retirement and a drop would schedule the SAME base delay and the test
				// could not tell them apart — it stayed green under the mutation that removed the reset.
				for (let i = 0; i < 4; i += 1) {
					created.at(-1)?.emit("close", {}); // ordinary drops
					await vi.advanceTimersByTimeAsync(20_000);
				}
				const beforeRetirement = created.length;

				// Now a SCHEDULED retirement: it must come back on the base delay, not the walked-up one.
				created.at(-1)?.emit("close", { code: 4001 });
				await vi.advanceTimersByTimeAsync(1100);
				expect(
					created.length,
					"a retirement that inherited the backoff would still be waiting here",
				).toBe(beforeRetirement + 1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("stop() ends reconnection for good", async () => {
			const client = make({
				reconcile: () => Promise.resolve({ knownServer: [], head: 0 }),
				onRemoteChange: () => Promise.resolve(),
			});
			await client.start();
			vi.useFakeTimers();
			try {
				created[0]?.emit("close", {});
				client.stop();
				await vi.advanceTimersByTimeAsync(60_000);
			} finally {
				vi.useRealTimers();
			}
			expect(created.length, "a stopped client must not come back").toBe(1);
		});
	});
});
