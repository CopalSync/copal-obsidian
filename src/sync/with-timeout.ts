/**
 * Race `promise` against a deadline, **clearing the timer when it settles**.
 *
 * ⚠️ The idiom this replaces — `Promise.race([p, new Promise((r) => setTimeout(r, ms))])` — leaks a
 * live timer for the full `ms` every time `p` wins, which is the normal case. One per note opened kept
 * the event loop busy and, in tests, kept fake timers non-empty forever. Resolves to
 * `{ timedOut: true }` rather than throwing, because a timeout here is an expected outcome (a slow or
 * dead socket) and not an error to handle.
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<{ timedOut: true }>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), ms);
	});
	try {
		return await Promise.race([
			promise.then((value) => ({ timedOut: false as const, value })),
			deadline,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * {@link withTimeout} for callers that have a sensible value to fall back to, rather than a branch.
 *
 * This is the single home for "bound this promise": there were three copies of the same eight lines —
 * one here, one in `token-manager.ts`, one inline in `legacy-purge.ts` — and a fourth site
 * (`serverReachable`) that used the leaking idiom instead. One helper, one behaviour.
 */
export async function withBudget<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
	const result = await withTimeout(work, ms);
	return result.timedOut ? onTimeout : result.value;
}
