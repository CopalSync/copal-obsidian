import { describe, expect, it } from "vitest";
import { conflictName, uniqueConflictName } from "../../src/sync/conflict-name";

const STAMP = { at: new Date("2026-09-14T14:01:00Z"), deviceId: "ab12cd34-ffff" };

describe("conflictName", () => {
	it("stamps the time and device, and keeps the extension", () => {
		const n = conflictName("dir/note.md", STAMP);
		expect(n.startsWith("dir/note (conflicted copy ")).toBe(true);
		expect(n.endsWith(".md")).toBe(true);
		expect(n).toContain("2026-09-14");
		expect(n).toContain("ab12cd"); // a short device tag, not the whole id
	});

	it("handles a name with no extension", () => {
		expect(conflictName("dir/README", STAMP).startsWith("dir/README (conflicted copy ")).toBe(true);
	});

	it("does not mistake a dot in a directory for an extension", () => {
		expect(conflictName("v1.2/note", STAMP)).toContain("v1.2/note (conflicted copy ");
	});

	/**
	 * S8. The name used to be the fixed string "(conflicted copy)", so the SECOND divergence on a note
	 * overwrote the copy the first one had preserved — the one place in the plugin whose whole job is
	 * that nothing is ever lost.
	 */
	it("gives two devices different names at the same instant", () => {
		const a = conflictName("n.md", { at: STAMP.at, deviceId: "aaaaaaaa" });
		const b = conflictName("n.md", { at: STAMP.at, deviceId: "bbbbbbbb" });
		expect(a).not.toBe(b);
	});

	it("gives the same device different names at different times", () => {
		const a = conflictName("n.md", { ...STAMP, at: new Date("2026-09-14T14:01:00Z") });
		const b = conflictName("n.md", { ...STAMP, at: new Date("2026-09-14T15:30:00Z") });
		expect(a).not.toBe(b);
	});
});

describe("uniqueConflictName", () => {
	it("returns the plain stamped name when nothing is in the way", async () => {
		const name = await uniqueConflictName("n.md", STAMP, () => Promise.resolve(false));
		expect(name).toBe(conflictName("n.md", STAMP));
	});

	/** Same device, same minute, twice — the counter is the last thing standing between the two. */
	it("never returns a name that already exists", async () => {
		const taken = new Set([conflictName("n.md", STAMP), conflictName("n.md", STAMP, 2)]);
		const name = await uniqueConflictName("n.md", STAMP, (p) => Promise.resolve(taken.has(p)));
		expect(taken.has(name), "handed back a name that would overwrite an existing copy").toBe(false);
		expect(name.endsWith(".md")).toBe(true);
	});

	it("gives up rather than looping forever when everything is taken", async () => {
		await expect(uniqueConflictName("n.md", STAMP, () => Promise.resolve(true))).rejects.toThrow(
			/conflict/i,
		);
	});
});
