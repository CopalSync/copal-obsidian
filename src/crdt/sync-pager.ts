/** Which queue an entry sits in. A `live` entry is a user's edit and must not wait behind an import. */
export type Lane = "live" | "bulk";

export interface PageEntry {
	path: string;
	/** Read the `.md` at drain time and merge it into the doc before the exchange. */
	readFile: boolean;
	/**
	 * Remote-wins for this note (an adopt reconcile). Carried per entry rather than held as engine state
	 * because `syncActive` is true while a reconcile runs, so a user's live edit can land mid-adopt and
	 * must NOT inherit remote-wins — that would discard their text instead of keeping a conflict copy.
	 */
	adopt: boolean;
}

export interface SyncPagerDeps {
	/**
	 * Exchange one page. Anything that must be retried for a per-item reason (the server deferred it, a
	 * push was refused) is the callback's to re-`notify`. If this THROWS — a dead network, say — the pager
	 * re-notifies the whole page itself, so a bug in the callback's own error handling cannot lose notes.
	 */
	drain: (entries: PageEntry[]) => Promise<void>;
	pageSize?: number;
	debounceMs?: number;
	log?: (msg: string) => void;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_DEBOUNCE_MS = 300;
/** Ceiling on the no-progress backoff, so an offline vault retries twice a minute rather than 3×/second. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Batches closed-note syncs into pages and decides what travels together.
 *
 * Replaces the old one-socket-per-note loop: `CrdtSync` used to mint a ticket, open a WebSocket, exchange
 * ops and sleep 1.5s for EVERY closed note, so a 10k-note first import took ~53 minutes and ~10k metered
 * calls — more than a solo plan's daily allowance, i.e. it could not finish at all.
 *
 * The guarantees that matter, and why:
 *
 * - **Nothing is dropped, and newest wins.** A path notified while it is already in the in-flight page is
 *   re-added to pending, so the next page re-reads it. The file is read at DRAIN time, never at notify
 *   time, because Obsidian autosaves several times inside one exchange and queuing the text would push a
 *   stale snapshot (that bug cost real edits once already — see `PathQueue`).
 * - **A path is never in two pages at once**, which falls out of one-drain-at-a-time plus dedupe by path.
 *   Deliberately NOT layered over `PathQueue`: that class serialises a single key, which is precisely what
 *   this already guarantees, so wrapping it would be ceremony. (`PathQueue` keeps its own consumer in
 *   `PluginDataStore`, where the "a run that STARTS AFTER this call" guarantee is load-bearing.)
 * - **`live` drains before `bulk`.** A user editing a note during a first import is not made to wait for
 *   10,000 notes, and a `live` notify upgrades a path already pending as `bulk`.
 * - **No-progress backs off.** A page where every path came straight back (offline, or a server refusing
 *   every push) doubles the delay to a 30s ceiling instead of spinning on the network.
 */
export class SyncPager {
	private readonly pending = new Map<string, { lane: Lane; readFile: boolean; adopt: boolean }>();
	/** Paths in the page currently being drained, so a notify for one can be re-queued rather than lost. */
	private inPage: Set<string> | undefined;
	private reNotified = new Set<string>();
	private cancelled = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private draining = false;
	private stopped = false;
	private backoff: number;
	private idleWaiters: Array<() => void> = [];

	constructor(private readonly deps: SyncPagerDeps) {
		this.backoff = this.base;
	}

	private get base(): number {
		return this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	}

	/** Queue `path` for its next page. Flags OR-merge, and `live` beats `bulk`. */
	notify(path: string, opts: { lane: Lane; readFile?: boolean; adopt?: boolean }): void {
		if (this.stopped) return;
		this.cancelled.delete(path);
		if (this.inPage?.has(path)) this.reNotified.add(path);
		const prev = this.pending.get(path);
		this.pending.set(path, {
			lane: prev?.lane === "live" || opts.lane === "live" ? "live" : "bulk",
			readFile: (prev?.readFile ?? false) || (opts.readFile ?? false),
			adopt: (prev?.adopt ?? false) || (opts.adopt ?? false),
		});
		this.schedule();
	}

	enqueueAll(paths: Iterable<string>, lane: Lane): void {
		for (const path of paths) this.notify(path, { lane });
	}

	/**
	 * Forget `path` — it was deleted or renamed away. If it is in the in-flight page it is marked
	 * cancelled, so the drain skips applying anything to a doc that is being destroyed underneath it.
	 */
	drop(path: string): void {
		this.pending.delete(path);
		if (this.inPage?.has(path)) this.cancelled.add(path);
		this.settle();
	}

	/** Whether `path` was dropped after this page began — the drain must not touch its doc. */
	isCancelled(path: string): boolean {
		return this.cancelled.has(path);
	}

	/** Resolves once nothing is pending and no page is in flight. */
	idle(): Promise<void> {
		if (this.quiet()) return Promise.resolve();
		return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	/** Refuse new work and abandon what is queued; an in-flight page finishes. Lets `idle()` resolve. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
		this.settle();
	}

	private quiet(): boolean {
		return this.pending.size === 0 && !this.draining;
	}

	private settle(): void {
		if (!this.quiet()) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private schedule(delay = this.base): void {
		if (this.stopped || this.draining || this.timer !== undefined) return;
		if (this.pending.size === 0) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.run();
		}, delay);
	}

	/** Take up to `pageSize` entries, `live` first. */
	private takePage(): PageEntry[] {
		const size = this.deps.pageSize ?? DEFAULT_PAGE_SIZE;
		const ordered = [...this.pending.entries()].sort(
			(a, b) => Number(b[1].lane === "live") - Number(a[1].lane === "live"),
		);
		const page = ordered.slice(0, size);
		for (const [path] of page) this.pending.delete(path);
		return page.map(([path, v]) => ({ path, readFile: v.readFile, adopt: v.adopt }));
	}

	private async run(): Promise<void> {
		if (this.draining || this.stopped) return;
		this.draining = true;
		try {
			while (this.pending.size > 0 && !this.stopped) {
				const entries = this.takePage();
				this.inPage = new Set(entries.map((e) => e.path));
				this.reNotified.clear();
				this.cancelled.clear();
				let threw = false;
				try {
					await this.deps.drain(entries.filter((e) => !this.cancelled.has(e.path)));
				} catch (err) {
					threw = true;
					this.deps.log?.(`sync page failed: ${err instanceof Error ? err.message : String(err)}`);
					// The callback never got to decide, so the pager re-queues the page itself.
					for (const e of entries) {
						if (!this.cancelled.has(e.path)) {
							this.reNotified.add(e.path);
							this.pending.set(e.path, { lane: "bulk", readFile: e.readFile, adopt: e.adopt });
						}
					}
				}
				const attempted = entries.filter((e) => !this.cancelled.has(e.path));
				const progressed = !threw && attempted.some((e) => !this.reNotified.has(e.path));
				this.inPage = undefined;
				if (progressed) {
					this.backoff = this.base;
					continue; // keep the pipeline hot — a bulk import should not pause between pages
				}
				this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
				break; // nothing moved; wait out the backoff rather than spin
			}
		} finally {
			this.draining = false;
			this.inPage = undefined;
			this.schedule(this.backoff);
			this.settle();
		}
	}
}
