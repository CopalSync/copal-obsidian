import { describe, expect, it } from "vitest";
import { STATUS_META, type SyncStatus } from "../../src/ui/status";

describe("STATUS_META", () => {
	const statuses: SyncStatus[] = ["idle", "syncing", "live", "offline"];

	it("maps every status to a defined icon/cls/label", () => {
		for (const s of statuses) {
			const meta = STATUS_META[s];
			expect(meta).toBeDefined();
			expect(meta.icon.length).toBeGreaterThan(0);
			expect(meta.cls.length).toBeGreaterThan(0);
			expect(meta.label.length).toBeGreaterThan(0);
		}
	});

	it("gives each status a distinct label", () => {
		const labels = statuses.map((s) => STATUS_META[s].label);
		expect(new Set(labels).size).toBe(labels.length);
	});
});
