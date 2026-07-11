import { describe, expect, it, vi } from "vitest";
import { ConnectFlow } from "../../src/connect/flow";
import { type PersistedData, TokenStore } from "../../src/connect/store";

const DISC = {
  registration_endpoint: "https://api.copal.uk/register",
  authorization_endpoint: "https://api.copal.uk/authorize",
  token_endpoint: "https://api.copal.uk/token",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

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
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(DISC))
      .mockResolvedValueOnce(json({ client_id: "cid" }, 201));
    const openUrl = vi.fn<(u: string) => void>();
    const store = memStore();
    const flow = new ConnectFlow({ f, store, openUrl, randomState: () => "st8" });
    await flow.start();
    expect(await store.getClientId()).toBe("cid");
    const url = new URL(openUrl.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe("https://api.copal.uk/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("handleCallback() exchanges the code and stores tokens", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(DISC))
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
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(DISC))
      .mockResolvedValueOnce(json({ client_id: "cid" }, 201));
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
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(json(DISC));
    const openUrl = vi.fn<(u: string) => void>();
    const flow = new ConnectFlow({ f, store, openUrl, randomState: () => "st8" });
    await flow.start();
    expect(f).toHaveBeenCalledTimes(1);
    expect(new URL(openUrl.mock.calls[0]![0]).searchParams.get("client_id")).toBe("existing");
  });
});
