import { describe, expect, it, vi } from "vitest";
import { ConnectFlow } from "../../src/connect/flow";
import { type PersistedData, TokenStore } from "../../src/connect/store";

// Discovery is two hops: the gateway's protected-resource document names the authorization
// server, and the authorization server's own metadata carries the endpoints. They are different
// hosts — the gateway issues no tokens — so the stub models both.
const PRM = {
	resource: "https://api.copal.uk/mcp",
	authorization_servers: ["https://auth.copal.uk"],
};
const DISC = {
	registration_endpoint: "https://auth.copal.uk/oauth2/register",
	authorization_endpoint: "https://auth.copal.uk/oauth2/authorize",
	token_endpoint: "https://auth.copal.uk/oauth2/token",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

/** The two discovery responses, in the order `discover()` asks for them. */
const discovery = (f: ReturnType<typeof vi.fn<typeof fetch>>) =>
	f.mockResolvedValueOnce(json(PRM)).mockResolvedValueOnce(json(DISC));

function memStore(): TokenStore {
	let data: PersistedData = {};
	return new TokenStore(
		() => Promise.resolve(data),
		(d) => {
			data = d;
			return Promise.resolve();
		},
	);
}

describe("ConnectFlow", () => {
	it("start() discovers, registers a client, and opens the authorize URL", async () => {
		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValueOnce(
			json({ client_id: "cid" }, 201),
		);
		const openUrl = vi.fn<(u: string) => void>();
		const store = memStore();
		const flow = new ConnectFlow({ f, store, openUrl, randomState: () => "st8" });
		await flow.start();
		expect(await store.getClientId()).toBe("cid");
		const url = new URL(openUrl.mock.calls[0]![0]);
		expect(url.origin + url.pathname).toBe("https://auth.copal.uk/oauth2/authorize");
		expect(url.searchParams.get("client_id")).toBe("cid");
		expect(url.searchParams.get("state")).toBe("st8");
		expect(url.searchParams.get("code_challenge")).toBeTruthy();
	});

	it("handleCallback() exchanges the code and stores tokens", async () => {
		const f = discovery(vi.fn<typeof fetch>())
			.mockResolvedValueOnce(json({ client_id: "cid" }, 201))
			.mockResolvedValueOnce(json({ access_token: "at", scope: "vault.read vault.write" }));
		const store = memStore();
		const flow = new ConnectFlow({
			f,
			store,
			openUrl: vi.fn<(u: string) => void>(),
			randomState: () => "st8",
		});
		await flow.start();
		const tokens = await flow.handleCallback({ code: "code123", state: "st8" });
		expect(tokens.access_token).toBe("at");
		expect(await store.isConnected()).toBe(true);
	});

	it("rejects a state mismatch", async () => {
		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValueOnce(
			json({ client_id: "cid" }, 201),
		);
		const flow = new ConnectFlow({
			f,
			store: memStore(),
			openUrl: vi.fn<(u: string) => void>(),
			randomState: () => "st8",
		});
		await flow.start();
		await expect(flow.handleCallback({ code: "c", state: "WRONG" })).rejects.toThrow(/state/);
	});

	it("rejects an error callback", async () => {
		const flow = new ConnectFlow({
			f: vi.fn<typeof fetch>(),
			store: memStore(),
			openUrl: vi.fn<(u: string) => void>(),
			randomState: () => "st8",
		});
		await expect(flow.handleCallback({ error: "access_denied" })).rejects.toThrow();
	});

	it("reuses a previously-registered client id (no re-registration)", async () => {
		const store = memStore();
		await store.setClientId("existing");
		const f = discovery(vi.fn<typeof fetch>());
		const openUrl = vi.fn<(u: string) => void>();
		const flow = new ConnectFlow({ f, store, openUrl, randomState: () => "st8" });
		await flow.start();
		expect(f).toHaveBeenCalledTimes(2); // discovery only — no re-registration
		expect(new URL(openUrl.mock.calls[0]![0]).searchParams.get("client_id")).toBe("existing");
	});
});
