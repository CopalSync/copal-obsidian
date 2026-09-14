/** When and where a conflict copy was made — what makes one distinguishable from the next. */
export interface ConflictStamp {
	at: Date;
	/** This install's device id; only a short prefix is used, enough to tell two devices apart. */
	deviceId: string;
}

/** How many stamped names to try before giving up rather than spinning. */
const MAX_ATTEMPTS = 50;

/** `2026-09-14 1401` — sortable, readable, and stable across timezones because it is taken from UTC. */
function stampText(at: Date): string {
	const iso = at.toISOString();
	return `${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/**
 * `dir/note.md` → `dir/note (conflicted copy 2026-09-14 1401 ab12cd).md` — the label for a keep-both
 * when two replicas diverge (a first-import CRDT divergence, or a last-writer-wins binary conflict).
 * Preserves the extension.
 *
 * ⚠️ **THE STAMP IS NOT DECORATION.** This used to return the fixed string `(conflicted copy)`, so the
 * second divergence on a note overwrote the copy the first had preserved — in the one place in the
 * plugin whose entire job is that nothing is ever lost. Two devices diverging on the same note, or one
 * device diverging twice, silently left a single copy.
 *
 * Time and device make collisions unlikely; `n` is what makes them impossible, and
 * {@link uniqueConflictName} is what supplies it. A caller that builds a name itself gets the
 * unlikeliness but not the guarantee.
 */
export function conflictName(path: string, stamp: ConflictStamp, n = 0): string {
	const device = stamp.deviceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6) || "unknown";
	const suffix = n > 0 ? ` ${n}` : "";
	const label = `(conflicted copy ${stampText(stamp.at)} ${device}${suffix})`;
	const dot = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	return dot > slash ? `${path.slice(0, dot)} ${label}${path.slice(dot)}` : `${path} ${label}`;
}

/**
 * The first stamped name that is not already taken.
 *
 * `exists` is the vault's own check — `VaultWriter.exists` and `BinaryFiles.exists` are both this shape
 * — so the guarantee is against what is actually on disk rather than against what this process happens
 * to remember writing.
 *
 * Throws rather than looping if every candidate is taken. A caller that cannot name a copy must fail
 * loudly: quietly reusing a name is the bug this function exists to remove.
 */
export async function uniqueConflictName(
	path: string,
	stamp: ConflictStamp,
	exists: (path: string) => Promise<boolean>,
): Promise<string> {
	for (let n = 0; n < MAX_ATTEMPTS; n += 1) {
		const candidate = conflictName(path, stamp, n);
		// oxlint-disable-next-line no-await-in-loop
		if (!(await exists(candidate))) return candidate;
	}
	throw new Error(`cannot name a conflict copy for ${path}: ${MAX_ATTEMPTS} names already taken`);
}
