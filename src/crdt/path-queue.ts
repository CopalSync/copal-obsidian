/** A unit of work for one path. Takes no arguments: the path is the queue's key, not the job's input. */
export type PathJob = () => Promise<void>;

interface Waiter {
	resolve: () => void;
	reject: (err: unknown) => void;
}

/**
 * Serialises work per path, with two ways to ask for it — and the difference between them IS the
 * lost-edit bug this exists to fix.
 *
 * The old `inFlight` map coalesced *intent* along with the work: a second caller was handed the first
 * caller's promise and its own reason for calling was discarded. That is right for a caller that means
 * "make sure this path is synced" (a remote change, a reconcile, a flush) and wrong for one that means
 * "the file changed on disk, go and read it" — a burst of autosaves lost everything after the first.
 *
 *  - {@link run} guarantees a job run that STARTS AFTER the call, so a local edit is never dropped. A
 *    burst collapses onto one re-run rather than a queue of them, because with read-at-dequeue each run
 *    reads the file itself and the final one therefore sees the final state.
 *  - {@link coalesce} rides an in-flight run, which is exactly the old behaviour.
 *
 * Both serialise: two runs for one path never overlap, so a path never has two transports open on one
 * Y.Doc. Nothing here is path-aware beyond using the string as a key.
 */
export class PathQueue {
	private readonly running = new Map<string, Promise<void>>();
	private readonly queued = new Map<string, { job: PathJob; waiters: Waiter[] }>();

	/**
	 * Run `job`, guaranteeing a run that begins after this call. If a run is already in flight for
	 * `path`, wait behind it — and if something is already waiting, join it and supersede its job: two
	 * pending reads of the same file would return the same bytes, so only the latest job is worth keeping.
	 */
	run(path: string, job: PathJob): Promise<void> {
		if (!this.running.has(path)) return this.start(path, job);
		const slot = this.queued.get(path);
		if (slot) {
			slot.job = job;
			return new Promise<void>((resolve, reject) => slot.waiters.push({ resolve, reject }));
		}
		return new Promise<void>((resolve, reject) => {
			this.queued.set(path, { job, waiters: [{ resolve, reject }] });
		});
	}

	/** Run `job` unless one is already in flight for `path`, in which case ride it. The old semantics. */
	coalesce(path: string, job: PathJob): Promise<void> {
		return this.running.get(path) ?? this.start(path, job);
	}

	/** Resolve once `path` has no running and no queued work. A failed job is not the drainer's business. */
	async drain(path: string): Promise<void> {
		while (this.running.has(path)) {
			// oxlint-disable-next-line no-await-in-loop
			await this.running.get(path)?.catch(() => undefined);
		}
	}

	/**
	 * Start a run and, when it settles either way, promote whatever queued behind it. A job that throws
	 * must still release the path: leaving `running` populated would wedge every later edit to that note.
	 */
	private start(path: string, job: PathJob): Promise<void> {
		const run = (async () => job())().finally(() => {
			this.running.delete(path);
			const next = this.queued.get(path);
			if (!next) return;
			this.queued.delete(path);
			this.start(path, next.job).then(
				() => {
					for (const w of next.waiters) w.resolve();
				},
				(err: unknown) => {
					for (const w of next.waiters) w.reject(err);
				},
			);
		});
		this.running.set(path, run);
		return run;
	}
}
