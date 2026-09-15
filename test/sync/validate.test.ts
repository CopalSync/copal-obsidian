import { describe, expect, it } from "vitest";
import { parseChange, parseManifest, parseYSync } from "../../src/sync/validate";

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

describe("parseYSync", () => {
	it("keeps well-formed items and drops ones with an unsafe path", () => {
		const items = parseYSync({
			items: [
				{ path: "ok.md", ok: true, update: "AAEC", sv: "AQ" },
				{ path: "../escape.md", ok: true, update: "AAEC" },
				{ path: "gone.md", ok: false, code: "GONE" },
			],
		});
		expect(items.map((i: { path: string }) => i.path)).toEqual(["ok.md", "gone.md"]);
		expect(items[0]?.sv).toBe("AQ");
		expect(items[1]?.code).toBe("GONE");
	});

	it("drops a non-string binary field rather than passing it through to Y.applyUpdate", () => {
		const items = parseYSync({ items: [{ path: "a.md", ok: true, update: 42, sv: {} }] });
		expect(items[0]?.update).toBeUndefined();
		expect(items[0]?.sv).toBeUndefined();
	});

	it("returns an empty page for a malformed body instead of throwing", () => {
		expect(parseYSync(null)).toEqual([]);
		expect(parseYSync({ items: "nope" })).toEqual([]);
	});
});
