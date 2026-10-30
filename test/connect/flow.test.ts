import { describe, expect, it, vi } from "vitest";
import { ConnectFlow } from "../../src/connect/flow";
import { CLIENT_ID } from "../../src/connect/oauth";
import type { TokenStore } from "../../src/connect/store";
import { memStore as memData, type Seed } from "../data/fake-plugin-data";

// Discovery is two hops: the gateway's protected-resource document names the authorization
// server, and the authorization server's own metadata carries the endpoints. They are different
// hosts — the gateway issues no tokens — so the stub models both.
const PRM = {
	resource: "https://api.copal.uk/mcp",
	authorization_servers: ["https://auth.copal.uk"],
};
const DISC = {
	// RFC 8414 §3.3: the issuer is the origin that served this document, and every endpoint shares it.
	issuer: "https://auth.copal.uk",
	authorization_endpoint: "https://auth.copal.uk/oauth2/authorize",
	token_endpoint: "https://auth.copal.uk/oauth2/token",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

/** The two discovery responses, in the order `discover()` asks for them. */
const discovery = (f: ReturnType<typeof vi.fn<typeof fetch>>) =>
	f.mockResolvedValueOnce(json(PRM)).mockResolvedValueOnce(json(DISC));

async function memStore(initial: Seed = {}): Promise<TokenStore> {
	return (await memData(initial)).store;
}

describe("ConnectFlow", () => {
	it("start() opens the authorize URL with the plugin's own client id, and registers nothing", async () => {
		// The plugin is a CIMD client: its id is the URL of a document only copal.uk serves, which is
		// what lets the consent screen mark it verified. Nothing is registered, so nothing can go stale.
		const f = discovery(vi.fn<typeof fetch>());
		const openUrl = vi.fn<(u: string) => void>();
		const flow = new ConnectFlow({ f, store: await memStore(), openUrl, randomState: () => "st8" });
		await flow.start();
		expect(f, "discovery only: no registration request").toHaveBeenCalledTimes(2);
		const url = new URL(openUrl.mock.calls[0]![0]);
		expect(url.origin + url.pathname).toBe("https://auth.copal.uk/oauth2/authorize");
		expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(url.searchParams.get("state")).toBe("st8");
		expect(url.searchParams.get("code_challenge")).toBeTruthy();
	});

	it("handleCallback() stores the tokens with the client they were issued to", async () => {
		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValueOnce(
			json({ access_token: "at", scope: "vault.read vault.write" }),
		);
		const store = await memStore();
		const flow = new ConnectFlow({
			f,
			store,
			openUrl: vi.fn<(u: string) => void>(),
			randomState: () => "st8",
		});
		await flow.start();
		const tokens = await flow.handleCallback({ code: "code123", state: "st8" });
		expect(tokens.access_token).toBe("at");
		expect(store.isConnected()).toBe(true);
		expect(store.getClientId(), "a refresh must present the client the tokens belong to").toBe(
			CLIENT_ID,
		);
	});

	it("moves an install off a self-registered client the next time it connects", async () => {
		// Older builds registered themselves and kept the id. Their tokens still belong to that id, so
		// a refresh keeps presenting it; the next connect is what moves them to the plugin's own id.
		const store = await memStore({
			clientId: "self-registered-by-an-older-build",
			tokens: { access_token: "old", refresh_token: "old-rt" },
		});
		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValueOnce(json({ access_token: "new" }));
		const openUrl = vi.fn<(u: string) => void>();
		const flow = new ConnectFlow({ f, store, openUrl, randomState: () => "st8" });
		await flow.start();
		expect(new URL(openUrl.mock.calls[0]![0]).searchParams.get("client_id")).toBe(CLIENT_ID);
		await flow.handleCallback({ code: "c", state: "st8" });
		expect(store.getClientId()).toBe(CLIENT_ID);
	});

	it("rejects a state mismatch", async () => {
		const flow = new ConnectFlow({
			f: discovery(vi.fn<typeof fetch>()),
			store: await memStore(),
			openUrl: vi.fn<(u: string) => void>(),
			randomState: () => "st8",
		});
		await flow.start();
		await expect(flow.handleCallback({ code: "c", state: "WRONG" })).rejects.toThrow(/state/);
	});

	it("rejects an error callback", async () => {
		const flow = new ConnectFlow({
			f: vi.fn<typeof fetch>(),
			store: await memStore(),
			openUrl: vi.fn<(u: string) => void>(),
			randomState: () => "st8",
		});
		await expect(flow.handleCallback({ error: "access_denied" })).rejects.toThrow();
	});
});

describe("ConnectFlow: the pending attempt is short-lived and single-use", () => {
	async function make(clock: { now: number }, tokenResponse = json({ access_token: "at" })) {
		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValue(tokenResponse);
		const store = await memStore();
		const flow = new ConnectFlow({
			f,
			store,
			openUrl: vi.fn<(u: string) => void>(),
			randomState: () => "st8",
			now: () => clock.now,
		});
		return { f, store, flow };
	}

	it("refuses a callback that arrives after the attempt has expired", async () => {
		const clock = { now: 1_000_000 };
		const { flow } = await make(clock);
		await flow.start();

		clock.now += 11 * 60 * 1000; // the browser tab sat open over a coffee

		await expect(flow.handleCallback({ code: "c", state: "st8" })).rejects.toThrow(/expired/i);
	});

	it("still accepts a callback inside the window", async () => {
		const clock = { now: 1_000_000 };
		const { flow } = await make(clock);
		await flow.start();
		clock.now += 9 * 60 * 1000;
		await expect(flow.handleCallback({ code: "c", state: "st8" })).resolves.toBeDefined();
	});

	it("consumes the attempt even when the exchange fails, so the code cannot be replayed", async () => {
		const clock = { now: 1_000_000 };
		const { flow } = await make(clock, json({ error: "invalid_grant" }, 400));
		await flow.start();

		await expect(flow.handleCallback({ code: "c", state: "st8" })).rejects.toThrow();
		// The verifier is spent. A second callback must not get another go at the exchange.
		await expect(flow.handleCallback({ code: "c", state: "st8" })).rejects.toThrow(/no pending/i);
	});

	/**
	 * ⛔ The other direction, and it is a real tension: clearing on a WRONG state would let anyone who
	 * can fire the deep link cancel a sign-in that is legitimately in progress.
	 */
	it("does NOT consume the attempt when the state does not match", async () => {
		const clock = { now: 1_000_000 };
		const { flow } = await make(clock);
		await flow.start();

		await expect(flow.handleCallback({ code: "c", state: "wrong" })).rejects.toThrow(/state/i);
		await expect(flow.handleCallback({ code: "c", state: "st8" })).resolves.toBeDefined();
	});

	it("does not put the callback's error text into the message", async () => {
		const clock = { now: 1_000_000 };
		const { flow } = await make(clock);
		await flow.start();

		const attacker = "Your vault is locked. Call 0800-NOT-COPAL to restore it.";
		await expect(flow.handleCallback({ error: attacker })).rejects.toThrow(
			expect.objectContaining({ message: expect.not.stringContaining("0800") }) as Error,
		);
	});
});
