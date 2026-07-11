import { describe, expect, it } from "vitest";
import { type PersistedData, TokenStore } from "../../src/connect/store";

function memStore(initial: PersistedData = {}) {
  let data: PersistedData = { ...initial };
  return {
    load: () => Promise.resolve(data),
    save: (d: PersistedData) => {
      data = d;
      return Promise.resolve();
    },
    peek: () => data,
  };
}

describe("TokenStore", () => {
  it("round-trips client id and tokens through the injected save", async () => {
    const m = memStore();
    const store = new TokenStore(m.load, m.save);
    await store.setClientId("cid");
    await store.setTokens({ access_token: "at", scope: "vault.read vault.write" });
    expect(await store.getClientId()).toBe("cid");
    expect((await store.getTokens())?.access_token).toBe("at");
    expect(m.peek().clientId).toBe("cid");
  });

  it("isConnected reflects the presence of an access token", async () => {
    const m = memStore();
    const store = new TokenStore(m.load, m.save);
    expect(await store.isConnected()).toBe(false);
    await store.setTokens({ access_token: "at" });
    expect(await store.isConnected()).toBe(true);
  });

  it("signOut() drops tokens but keeps the vault link (sign back in → resume)", async () => {
    const m = memStore();
    const store = new TokenStore(m.load, m.save);
    await store.setClientId("cid");
    await store.setTokens({ access_token: "at" });
    await store.setVault("vlt_1", "Work");
    await store.signOut();
    expect(await store.getTokens()).toBeUndefined();
    expect(await store.isConnected()).toBe(false);
    expect(await store.getVaultId()).toBe("vlt_1"); // link kept → resume on sign-in
    expect(await store.getClientId()).toBe("cid");
  });

  it("unlinkVault() drops the vault link but stays signed in (linked vault vanished)", async () => {
    const m = memStore();
    const store = new TokenStore(m.load, m.save);
    await store.setTokens({ access_token: "at" });
    await store.setVault("vlt_1", "Work");
    await store.unlinkVault();
    expect(await store.getVaultId()).toBeUndefined();
    expect(await store.getVaultName()).toBeUndefined();
    expect(await store.isConnected()).toBe(true); // still signed in
  });

  it("tolerates a null initial load (fresh install)", async () => {
    const store = new TokenStore(
      () => Promise.resolve(null),
      () => Promise.resolve(),
    );
    expect(await store.getClientId()).toBeUndefined();
    expect(await store.isConnected()).toBe(false);
  });

  it("getDeviceId generates once and returns the same id thereafter", async () => {
    const m = memStore();
    const store = new TokenStore(m.load, m.save);
    const first = await store.getDeviceId();
    expect(first).toMatch(/[0-9a-f-]{36}/);
    expect(await store.getDeviceId()).toBe(first);
    expect(m.peek().deviceId).toBe(first);
  });
});
