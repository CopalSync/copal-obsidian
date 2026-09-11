import { requestUrl } from "obsidian";

/**
 * A `fetch`-shaped adapter over Obsidian's `requestUrl`. Plugin requests to api.copal.uk are cross-origin
 * from `app://obsidian.md` and would be CORS-blocked with the browser `fetch`; `requestUrl` is a native
 * request that bypasses CORS.
 *
 * The `Response` is built from the raw `arrayBuffer`, so it serves BOTH the JSON endpoints (via `.json()`
 * /`.text()`) and the binary attachment endpoints (via `.arrayBuffer()`). Response headers are forwarded
 * so `ETag` (last-writer-wins) and `Content-Type` survive; `content-encoding`/`content-length` are dropped
 * because `requestUrl` already decoded the body, so those headers would no longer match.
 */
export const requestUrlFetch: typeof fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input.toString();
	const res = await requestUrl({
		url,
		method: init?.method ?? "GET",
		...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
		...(init?.body === undefined || init?.body === null
			? {}
			: { body: init.body as string | ArrayBuffer }),
		throw: false,
	});
	const headers = new Headers();
	for (const [key, value] of Object.entries(res.headers ?? {})) {
		const lower = key.toLowerCase();
		if (lower === "content-encoding" || lower === "content-length") continue;
		headers.set(key, value);
	}
	if (!headers.has("content-type")) headers.set("content-type", "application/json");
	return new Response(res.arrayBuffer, { status: res.status, headers });
};
