import { describe, expect, it } from "vitest";
import { requestUrlFetch } from "../../src/sync/request-url-fetch";
import { __setRequestUrl, type RequestUrlParam, type RequestUrlResponse } from "../stubs/obsidian";

function response(
	arrayBuffer: ArrayBuffer,
	headers: Record<string, string> = {},
	status = 200,
): RequestUrlResponse {
	return { status, headers, arrayBuffer, text: "", json: undefined };
}

/**
 * The `fetch`-shaped adapter over Obsidian's CORS-free `requestUrl`. E3 needs it to carry BINARY bodies
 * and responses (attachment sync) and to preserve the `ETag`/`Content-Type` response headers — while the
 * existing JSON endpoints keep working.
 */
describe("requestUrlFetch adapter", () => {
	it("returns the response bytes, status, and headers (ETag + Content-Type survive)", async () => {
		__setRequestUrl(() =>
			Promise.resolve(
				response(new Uint8Array([1, 2, 3, 255]).buffer, {
					"content-type": "image/png",
					etag: '"e1"',
				}),
			),
		);
		const res = await requestUrlFetch("https://api.copal.uk/file/a.png");
		expect(res.status).toBe(200);
		expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 255]);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("etag")).toBe('"e1"');
	});

	it("forwards the method, headers, and binary body through to requestUrl", async () => {
		let captured: RequestUrlParam | undefined;
		__setRequestUrl((p) => {
			captured = p;
			return Promise.resolve(response(new Uint8Array().buffer, { etag: '"e2"' }, 201));
		});
		const body = new Uint8Array([9, 9]).buffer;
		await requestUrlFetch("https://api.copal.uk/file/a.png", {
			method: "PUT",
			headers: { "If-Match": '"e1"' },
			body,
		});
		// Narrowed rather than optional-chained: indexing `headers` off an undefined `captured` would
		// throw a TypeError that reads as a broken test rather than as "requestUrl was never called".
		if (captured === undefined) throw new Error("requestUrl was never called");
		expect(captured.method).toBe("PUT");
		expect((captured.headers as Record<string, string>)["If-Match"]).toBe('"e1"');
		expect(captured.body).toBe(body);
	});

	it("parses a JSON response body so the text endpoints keep working", async () => {
		const payload = JSON.stringify({ head: 7, manifest: [] });
		__setRequestUrl(() =>
			Promise.resolve({
				status: 200,
				headers: {},
				arrayBuffer: new TextEncoder().encode(payload).buffer as ArrayBuffer,
				text: payload,
				json: undefined,
			}),
		);
		const res = await requestUrlFetch("https://api.copal.uk/sync/changes?since=0");
		expect(await res.json()).toEqual({ head: 7, manifest: [] });
		expect(res.headers.get("content-type")).toBe("application/json"); // defaulted when the server omits it
	});
});
