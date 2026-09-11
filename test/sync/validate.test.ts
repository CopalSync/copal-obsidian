import { describe, expect, it } from "vitest";
import {
	parseBatch,
	parseChange,
	parseChangesResponse,
	parseManifest,
} from "../../src/sync/validate";

describe("parseChange", () => {
	it("accepts a well-formed put frame", () => {
		expect(
			parseChange({ seq: 3, path: "b.md", op: "put", origin: "agent", ts: 1, version: "v1" }),
		).toEqual({ seq: 3, path: "b.md", op: "put", origin: "agent", ts: 1, version: "v1" });
	});
	it("drops an unknown op", () => {
		expect(parseChange({ seq: 1, path: "a.md", op: "frob", origin: "x", ts: 0 })).toBeNull();
	});
	it("drops an unsafe (traversal) path", () => {
		expect(parseChange({ seq: 1, path: "../evil.md", op: "put", origin: "x", ts: 0 })).toBeNull();
	});
	it("drops a non-numeric seq or a non-object", () => {
		expect(parseChange({ seq: "3", path: "a.md", op: "put", origin: "x", ts: 0 })).toBeNull();
		expect(parseChange(null)).toBeNull();
	});
});

describe("parseManifest", () => {
	it("keeps well-formed entries and drops malformed ones", () => {
		const { head, manifest } = parseManifest({
			head: 5,
			manifest: [
				{ path: "a.md", version: "v1", size: 1, mtime: 2 },
				{ path: 123, version: "v", size: 1, mtime: 1 }, // non-string path
				{ path: "../x.md", version: "v", size: 1, mtime: 1 }, // traversal
				{ version: "v" }, // no path
			],
		});
		expect(head).toBe(5);
		expect(manifest.map((e) => e.path)).toEqual(["a.md"]);
	});
	it("defaults head to 0 and manifest to [] on a bad shape", () => {
		expect(parseManifest(null)).toEqual({ head: 0, manifest: [] });
		expect(parseManifest({ head: "x" })).toEqual({ head: 0, manifest: [] });
	});
});

describe("parseChangesResponse", () => {
	it("filters malformed frames but preserves the order of valid ones", () => {
		const { head, changes } = parseChangesResponse({
			head: 9,
			changes: [
				{ seq: 1, path: "a.md", op: "put", origin: "x", ts: 0 },
				{ seq: 2, path: "../evil.md", op: "put", origin: "x", ts: 0 },
				{ seq: 3, path: "c.md", op: "delete", origin: "x", ts: 0 },
			],
		});
		expect(head).toBe(9);
		expect(changes.map((c) => c.path)).toEqual(["a.md", "c.md"]);
	});
});

describe("parseBatch", () => {
	it("keeps ok notes with a safe path + string content, drops the rest", () => {
		const notes = parseBatch({
			get: [
				{
					path: "a.md",
					ok: true,
					note: { path: "a.md", content: "hi", version: "v1", mtime: 1, size: 2 },
				},
				{ path: "b.md", ok: false, code: "NOT_FOUND" },
				{ path: "c.md", ok: true, note: { path: "../c.md", content: "x", mtime: 1, size: 1 } },
			],
		});
		expect(notes.map((n) => n.path)).toEqual(["a.md"]);
		expect(notes[0]?.content).toBe("hi");
	});
});
