import { describe, expect, it, vi } from "vitest";
import { ConnectFlow } from "../../src/connect/flow";
import { SCOPE } from "../../src/connect/oauth";
import { type PersistedData, TokenStore } from "../../src/connect/store";

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
		// A COMPLETED attempt AND a matching scope are what make a stored registration trustworthy.
		// An id alone now describes an install that predates one or both marks, which re-registers on
		// purpose — see the migration cases below.
		await store.setClientRegistration("existing", SCOPE);
		await store.setConnectAttemptPending(false);
		const f = discovery(vi.fn<typeof fetch>());
		const openUrl = vi.fn<(u: string) => void>();
		const flow = new ConnectFlow({ f, store, openUrl, randomState: () => "st8" });
		await flow.start();
		expect(f).toHaveBeenCalledTimes(2); // discovery only — no re-registration
		expect(new URL(openUrl.mock.calls[0]![0]).searchParams.get("client_id")).toBe("existing");
	});
});

/**
 * ⛔ THE DEAD-END THIS EXISTS TO PREVENT.
 *
 * A stored registration the server has forgotten could not be recovered from inside the plugin:
 * `/oauth2/authorize` refuses an unknown client BEFORE it will redirect anywhere that client
 * nominated, so the failure never reaches `handleCallback`; and `clientId` is deliberately kept
 * across disconnects, so reconnecting reused the same dead id. The only exit was deleting
 * `data.json` by hand.
 *
 * Measured against production 2026-09-11: an unknown client returns `invalid_client` with the
 * message **"client_id is required"**, which reads like a missing parameter. A genuinely missing
 * one returns `invalid_request` / "client_id: client_id is required". That wording is why this took
 * a while to find, and it is why the recovery cannot depend on reading the error.
 */
describe("ConnectFlow — recovering from a registration the server has forgotten", () => {
	it("re-registers when the previous attempt never came back", async () => {
		const store = memStore();
		await store.setClientId("dead-client-from-before-the-reset");
		await store.setConnectAttemptPending(true);

		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValueOnce(
			json({ client_id: "fresh" }, 201),
		);
		const openUrl = vi.fn<(u: string) => void>();
		await new ConnectFlow({ f, store, openUrl, randomState: () => "st8" }).start();

		expect(await store.getClientId()).toBe("fresh");
		expect(new URL(openUrl.mock.calls[0]![0]).searchParams.get("client_id")).toBe("fresh");
	});

	it("⛔ KEEPS the registration when the last attempt completed", async () => {
		// The falsifier for the test above. If `start()` simply discarded the client every time, that
		// test would pass while the plugin registered a new client on every single connect.
		const store = memStore();
		await store.setClientRegistration("known-good", SCOPE);
		await store.setConnectAttemptPending(false);

		const f = discovery(vi.fn<typeof fetch>());
		const openUrl = vi.fn<(u: string) => void>();
		await new ConnectFlow({ f, store, openUrl, randomState: () => "st8" }).start();

		expect(await store.getClientId()).toBe("known-good");
		expect(new URL(openUrl.mock.calls[0]![0]).searchParams.get("client_id")).toBe("known-good");
	});

	it("clears the mark once a callback lands, so the next connect keeps its client", async () => {
		const store = memStore();
		const f = discovery(vi.fn<typeof fetch>())
			.mockResolvedValueOnce(json({ client_id: "cid" }, 201))
			.mockResolvedValueOnce(json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
		const openUrl = vi.fn<(u: string) => void>();
		const flow = new ConnectFlow({ f, store, openUrl, randomState: () => "st8" });

		await flow.start();
		expect(await store.getConnectAttemptPending()).toBe(true);
		await flow.handleCallback({ code: "c0de", state: "st8" });
		expect(await store.getConnectAttemptPending()).toBe(false);
	});
});

describe("ConnectFlow — the migration for installs that predate the mark", () => {
	it("⛔ re-registers on the FIRST connect when no attempt was ever recorded", async () => {
		// The case that matters most: a phone already stuck on a dead registration, updating to the
		// build that fixes it. `undefined` is not `false` — treating it as "the last attempt was
		// fine" would reuse the dead id and fail identically, and the fix would only bite on the
		// second try, which is no use to somebody who is already stuck.
		const store = memStore();
		await store.setClientId("dead-client-from-before-the-reset");
		expect(await store.getConnectAttemptPending()).toBeUndefined();

		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValueOnce(
			json({ client_id: "fresh" }, 201),
		);
		const openUrl = vi.fn<(u: string) => void>();
		await new ConnectFlow({ f, store, openUrl, randomState: () => "st8" }).start();

		expect(await store.getClientId()).toBe("fresh");
		expect(new URL(openUrl.mock.calls[0]![0]).searchParams.get("client_id")).toBe("fresh");
	});
});

/**
 * ⛔ **A REGISTRATION MADE WITH A DIFFERENT SCOPE IS DEAD, AND FAILS WHERE NOBODY CAN SEE IT.**
 *
 * `/oauth2/authorize` validates the requested scope against `client.scopes` captured at
 * registration and answers `invalid_scope`. When `offline_access` was added to `SCOPE`, every
 * install held a narrower registration AND had `connectAttemptPending === false` — so without this
 * the mark would have kept the dead client and turned a silent hourly breakage into "cannot sign in
 * at all", on software already on people's phones.
 */
describe("ConnectFlow — a registration is only reusable at the scope it was made with", () => {
	it("⛔ re-registers when the stored scope is narrower than SCOPE", async () => {
		const store = memStore();
		await store.setClientRegistration("narrow-client", "vault.read vault.write");
		await store.setConnectAttemptPending(false);

		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValueOnce(
			json({ client_id: "wide" }, 201),
		);
		const openUrl = vi.fn<(u: string) => void>();
		await new ConnectFlow({ f, store, openUrl, randomState: () => "st8" }).start();

		expect(await store.getClientId()).toBe("wide");
		expect(new URL(openUrl.mock.calls[0]![0]).searchParams.get("scope")).toBe(SCOPE);
	});

	it("re-registers when the scope was never recorded (the migration)", async () => {
		const store = memStore();
		await store.setClientId("pre-scope-client");
		await store.setConnectAttemptPending(false);
		expect(await store.getClientScope()).toBeUndefined();

		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValueOnce(
			json({ client_id: "fresh" }, 201),
		);
		await new ConnectFlow({
			f,
			store,
			openUrl: vi.fn<(u: string) => void>(),
			randomState: () => "st8",
		}).start();

		expect(await store.getClientId()).toBe("fresh");
	});

	it("persists the scope it registered with, so the NEXT connect reuses the client", async () => {
		const store = memStore();
		const f = discovery(vi.fn<typeof fetch>()).mockResolvedValueOnce(
			json({ client_id: "cid" }, 201),
		);
		const flow = new ConnectFlow({
			f,
			store,
			openUrl: vi.fn<(u: string) => void>(),
			randomState: () => "st8",
		});

		await flow.start();
		expect(await store.getClientScope()).toBe(SCOPE);

		await flow.handleCallback.call(flow, { code: "x", state: "st8" }).catch(() => undefined);
	});

	/**
	 * The falsifier for the normaliser. A raw string compare would re-register every install on the
	 * planet for a purely cosmetic reorder, and the server accumulates a client row for each.
	 */
	it("⛔ does NOT re-register when the scope is merely REORDERED", async () => {
		const reordered = SCOPE.split(" ").reverse().join(" ");
		const store = memStore();
		await store.setClientRegistration("known-good", reordered);
		await store.setConnectAttemptPending(false);

		const f = discovery(vi.fn<typeof fetch>());
		const openUrl = vi.fn<(u: string) => void>();
		await new ConnectFlow({ f, store, openUrl, randomState: () => "st8" }).start();

		expect(await store.getClientId()).toBe("known-good");
	});
});
