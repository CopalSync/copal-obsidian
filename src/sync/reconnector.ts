/**
 * One reconnect policy, for every socket. ROADMAP P8.
 *
 * There were two, and neither was complete: `crdt/ws-transport.ts` had capped exponential backoff with
 * no jitter, and `sync/live.ts` had a FLAT 3s retry with no backoff at all. Both retried an authentication
 * failure for ever, and neither knew the device had gone offline or the app had been backgrounded.
 *
 * What this adds beyond "wait longer each time":
 *
 *  - **Jitter.** Without it every client that dropped on the same server blip comes back in the same
 *    millisecond, which is how a recovering server gets knocked over by its own clients. The delay is
 *    spread across a window rather than being exact.
 *  - **Offline awareness.** Retrying while `navigator.onLine` is false is guaranteed to fail, and on a
 *    phone it is the radio and the battery that pay. It parks instead, and the `online` event wakes it
 *    IMMEDIATELY rather than leaving the user to wait out a 15s backoff they can see is wrong.
 *  - **Visibility awareness.** Returning to a backgrounded app reconnects at once, for the same reason.
 *  - **Auth-failure handling.** A 401 does not get better by being retried: the credential is the
 *    problem. It stops and hands the decision to the caller, which is the only layer that can ask the
 *    user to sign in again.
 *
 * ⚠️ Every DOM hook is optional and guarded. This runs in Obsidian's webview on desktop and mobile, and
 * a missing `navigator.onLine` or `document` must degrade to plain backoff, never throw — a throw here
 * would lose the reconnect entirely and turn a blip into a permanently dead socket.
 */

/** Spread each delay across this fraction of itself, so clients do not return in lockstep. */
const JITTER = 0.3;

export interface ReconnectorOptions {
	/** First delay, doubled per consecutive failure. */
	baseMs: number;
	/** Ceiling on the doubling. */
	capMs: number;
	/** Do the connect. Thrown errors are the caller's to handle; this only schedules. */
	connect: () => void;
	/** Optional: called when retrying is pointless because the credential was refused. */
	onAuthFailure?: () => void;
}

export class Reconnector {
	private attempt = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	/** Set while parked waiting for `online` / visibility, so a wake knows there is work to resume. */
	private pending = false;
	private readonly listeners: (() => void)[] = [];

	constructor(private readonly opts: ReconnectorOptions) {
		this.listen(globalThis as EventTarget | undefined, "online", () => this.wake());
		this.listen(globalThis as EventTarget | undefined, "focus", () => this.wake());
		this.listen(
			typeof document === "undefined" ? undefined : (document as unknown as EventTarget),
			"visibilitychange",
			() => {
				if (typeof document !== "undefined" && document.visibilityState === "visible") this.wake();
			},
		);
	}

	private listen(target: EventTarget | undefined, type: string, handler: () => void): void {
		if (target?.addEventListener === undefined) return;
		try {
			target.addEventListener(type, handler);
			this.listeners.push(() => target.removeEventListener(type, handler));
		} catch {
			/* no DOM here — plain backoff is the fallback */
		}
	}

	/** `false` only when the platform says so; an unknown state counts as online. */
	private get online(): boolean {
		const flag = (globalThis as { navigator?: { onLine?: unknown } }).navigator?.onLine;
		return typeof flag === "boolean" ? flag : true;
	}

	/** The delay for the current attempt, jittered. Exposed for tests and for logging. */
	delayFor(attempt: number): number {
		const exact = Math.min(this.opts.baseMs * 2 ** attempt, this.opts.capMs);
		return Math.round(exact * (1 - JITTER + Math.random() * JITTER));
	}

	/** A connection succeeded: the next failure starts from the base delay again. */
	succeeded(): void {
		this.attempt = 0;
	}

	/**
	 * The socket was retired on schedule rather than failing. Resets the backoff WITHOUT counting a
	 * failure: a note left open all day would otherwise walk to the cap through nothing but healthy
	 * half-hourly rotations, and then a real drop would wait the full cap to recover.
	 */
	scheduledRetirement(): void {
		this.attempt = 0;
	}

	/** Retrying cannot fix this — the credential was refused. Stops, and tells the caller. */
	authFailed(): void {
		this.stop();
		this.opts.onAuthFailure?.();
	}

	/** Schedule the next attempt, or park until the device is back. */
	schedule(): void {
		if (this.stopped || this.timer !== undefined) return;
		this.pending = true;
		if (!this.online) return; // parked: `online` will wake it with no delay at all
		const delay = this.delayFor(this.attempt);
		this.attempt += 1;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.pending = false;
			if (!this.stopped) this.opts.connect();
		}, delay);
	}

	/**
	 * Came back online, or back into view: connect NOW instead of serving out the backoff.
	 *
	 * ⚠️ Does NOT reset `attempt`. If the network is flapping, the delay must keep growing — a wake is
	 * evidence that conditions changed, not that the server is healthy.
	 */
	private wake(): void {
		if (this.stopped || !this.pending || !this.online) return;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.pending = false;
		this.opts.connect();
	}

	/** Stop reconnecting and release every listener. Idempotent. */
	stop(): void {
		this.stopped = true;
		this.pending = false;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		for (const off of this.listeners.splice(0, this.listeners.length)) off();
	}

	/** Test/diagnostic: how many consecutive failures have been counted. */
	get attempts(): number {
		return this.attempt;
	}
}
