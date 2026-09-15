import { describe, expect, it, vi } from "vitest";
import { ApiError, SyncApi } from "../../src/sync/api";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const bearer = (call: [unknown, RequestInit | undefined]) =>
	((call[1]?.headers ?? {}) as Record<string, string>).authorization;

/**
 * The reactive half of token renewal: a 401 refreshes once and retries.
 *
 * ⛔ This is not redundant with the proactive `expires_at` check. There is ZERO clock tolerance
 * anywhere in the stack (jose defaults `clockTolerance` to 0), phones sleep and wake with skewed
 * clocks, and `expires_at` is absent entirely if a token response omits `expires_in`. Each of those
 * produces a token that looks fine locally and 401s at the edge, and the proactive path never fires.
 */
describe("SyncApi 401 → refresh → retry", () => {
	it("refreshes once and retries with the NEW bearer", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ error: "Unauthorized" }, 401))
			.mockResolvedValueOnce(json({ vaults: [] }));
		const onUnauthorized = vi.fn(async () => "new-token");

		const api = new SyncApi({ f, getToken: async () => "old-token", onUnauthorized });
		await expect(api.listVaults()).resolves.toEqual([]);

		expect(onUnauthorized).toHaveBeenCalledWith("old-token");
		expect(f).toHaveBeenCalledTimes(2);
		expect(bearer(f.mock.calls[0] as never)).toBe("Bearer old-token");
		expect(bearer(f.mock.calls[1] as never), "the retry reused the dead token").toBe(
			"Bearer new-token",
		);
	});

	/** Bounded: one retry, never recursive. A loop here would be the original bug with extra steps. */
	it("surfaces the 401 after exactly TWO fetches when the retry also fails", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "Unauthorized" }, 401));
		const api = new SyncApi({
			f,
			getToken: async () => "old",
			onUnauthorized: async () => "new",
		});

		await expect(api.listVaults()).rejects.toBeInstanceOf(ApiError);
		expect(f, "the retry recursed instead of giving up").toHaveBeenCalledTimes(2);
	});

	it("does not retry when the refresh declines (null)", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "Unauthorized" }, 401));
		const api = new SyncApi({
			f,
			getToken: async () => "old",
			onUnauthorized: async () => null,
		});

		await expect(api.listVaults()).rejects.toMatchObject({ status: 401 });
		expect(f).toHaveBeenCalledTimes(1);
	});

	it("never calls the refresh hook on a non-401", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "Forbidden" }, 403));
		const onUnauthorized = vi.fn(async () => "new");
		const api = new SyncApi({ f, getToken: async () => "t", onUnauthorized });

		await expect(api.listVaults()).rejects.toMatchObject({ status: 403 });
		expect(onUnauthorized).not.toHaveBeenCalled();
	});

	/**
	 * A retry re-sends the body. Safe today because every body here is a string or an ArrayBuffer —
	 * a `ReadableStream` added later would be consumed by the first attempt and send empty on the
	 * second, silently writing a zero-byte attachment. This pins the binary case.
	 */
	it("re-sends a binary body intact on the retry", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ error: "Unauthorized" }, 401))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const api = new SyncApi({
			f,
			getToken: async () => "old",
			onUnauthorized: async () => "new",
		});

		const body = new Uint8Array([1, 2, 3, 4]).buffer;
		await api.putFile("img.png", body, "image/png");

		expect(f).toHaveBeenCalledTimes(2);
		expect(f.mock.calls[1]![1]?.body, "the retry sent a different body").toBe(body);
	});

	/** The ticket mints are where the outage actually showed: 6550 of these 401s in a week. */
	it("recovers a WebSocket ticket mint after a 401", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ error: "Unauthorized" }, 401))
			.mockResolvedValueOnce(json({ ticket: "tkt", url: "wss://api.copal.uk/sync" }));
		const api = new SyncApi({
			f,
			getToken: async () => "old",
			onUnauthorized: async () => "new",
		});

		await expect(api.ticket()).resolves.toEqual({ ticket: "tkt", url: "wss://api.copal.uk/sync" });
	});

	/** Without a hook the client behaves exactly as before — no retry, no swallowed error. */
	it("passes the 401 straight through when no refresh hook is wired", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "Unauthorized" }, 401));
		await expect(new SyncApi({ f, getToken: async () => "t" }).ticket()).rejects.toMatchObject({
			status: 401,
		});
		expect(f).toHaveBeenCalledTimes(1);
	});
});

/**
 * Every method carries its status now. Ten of twelve threw a bare `Error` before, which is why the
 * search pane's 401 branch was DEAD CODE — it tested `instanceof ApiError` against an error that
 * could never be one, so an expired session always read "Search is unavailable right now."
 */
describe("every SyncApi method throws ApiError", () => {
	const cases: [string, (a: SyncApi) => Promise<unknown>][] = [
		["manifest", (a) => a.manifest()],
		["search", (a) => a.search("q")],
		["ycrdtSync", (a) => a.ycrdtSync({ items: [{ path: "a.md", sv: "AQ" }] })],
		["ticket", (a) => a.ticket()],
		["ycrdtTicket", (a) => a.ycrdtTicket()],
	];

	for (const [name, call] of cases) {
		it(`${name}() throws ApiError carrying the status`, async () => {
			const f = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "Unauthorized" }, 401));
			const api = new SyncApi({ f, getToken: async () => "t" });
			await expect(call(api)).rejects.toMatchObject({ name: "ApiError", status: 401 });
		});
	}
});
