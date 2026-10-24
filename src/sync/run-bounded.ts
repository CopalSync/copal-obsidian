/**
 * Bounded concurrency, in one place.
 *
 * There were two identical copies of `runBounded` — `crdt/crdt-sync.ts` and `sync/binary-sync.ts` — and
 * P4 needed a third shape, so they share this instead.
 */

/** Run `thunks` with at most `limit` in flight; a thrown thunk is swallowed (best-effort populate). */
export async function runBounded(limit: number, thunks: Array<() => Promise<void>>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < thunks.length) {
			const idx = next++;
			await thunks[idx]?.().catch(() => undefined);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
}

/** A task that knows roughly how many bytes it will hold in memory while it runs. */
export interface SizedTask {
	bytes: number;
	run: () => Promise<void>;
}

/**
 * Bounded by BOTH a task count and a total in-flight byte budget.
 *
 * ⚠️ Why bytes and not just a count: six concurrent 100 MB attachments is 600 MB resident, and on a
 * phone that is the process. A count alone cannot see that, because it treats a 2 KB icon and a 90 MB
 * video as the same unit of work. ROADMAP P4.
 *
 * A single task larger than the whole budget still runs, alone — refusing it would mean a file that can
 * never sync, which is worse than one slow transfer. The budget is advisory for that case and exact for
 * every other.
 */
export async function runWithinBudget(
	limit: number,
	maxBytes: number,
	tasks: readonly SizedTask[],
): Promise<void> {
	let next = 0;
	let inFlightBytes = 0;
	/** Resolvers for workers parked because admitting their task would breach the budget. */
	const waiting: (() => void)[] = [];

	const release = (bytes: number): void => {
		inFlightBytes -= bytes;
		// Wake everyone and let each re-test the budget: a small task may now fit where a large one
		// cannot, and waking only the head would stall behind it.
		const woken = waiting.splice(0, waiting.length);
		for (const wake of woken) wake();
	};

	const worker = async (): Promise<void> => {
		while (next < tasks.length) {
			const task = tasks[next++];
			if (task === undefined) return;
			// Park until this task fits, unless nothing is in flight — in which case it is this task's
			// turn regardless of size, or it would never run at all.
			while (inFlightBytes > 0 && inFlightBytes + task.bytes > maxBytes) {
				// oxlint-disable-next-line no-await-in-loop -- parking is the point
				await new Promise<void>((resolve) => waiting.push(resolve));
			}
			inFlightBytes += task.bytes;
			try {
				await task.run();
			} catch {
				/* best-effort, as runBounded */
			} finally {
				release(task.bytes);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}
