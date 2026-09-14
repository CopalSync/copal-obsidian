import { describe, expect, it } from "vitest";
import { TokenStore } from "../../src/connect/store";
import { PluginDataStore } from "../../src/data/plugin-data-store";
import { memStore } from "../data/fake-plugin-data";

describe("TokenStore", () => {
	it("round-trips client id and tokens through the injected save", async () => {
		const m = await memStore();
		const store = m.store;
		await store.setClientId("cid");
		await store.setTokens({ access_token: "at", scope: "vault.read vault.write" });
		expect(store.getClientId()).toBe("cid");
		expect(store.getTokens()?.access_token).toBe("at");
		expect(m.peek().clientId).toBe("cid");
	});

	it("isConnected reflects the presence of an access token", async () => {
		const m = await memStore();
		const store = m.store;
		expect(store.isConnected()).toBe(false);
		await store.setTokens({ access_token: "at" });
		expect(store.isConnected()).toBe(true);
	});

	it("signOut() drops tokens but keeps the vault link (sign back in → resume)", async () => {
		const m = await memStore();
		const store = m.store;
		await store.setClientId("cid");
		await store.setTokens({ access_token: "at" });
		await store.setVault("vlt_1", "Work");
		await store.signOut();
		expect(store.getTokens()).toBeUndefined();
		expect(store.isConnected()).toBe(false);
		expect(store.getVaultId()).toBe("vlt_1"); // link kept → resume on sign-in
		expect(store.getClientId()).toBe("cid");
	});

	it("unlinkVault() drops the vault link but stays signed in (linked vault vanished)", async () => {
		const m = await memStore();
		const store = m.store;
		await store.setTokens({ access_token: "at" });
		await store.setVault("vlt_1", "Work");
		await store.unlinkVault();
		expect(store.getVaultId()).toBeUndefined();
		expect(store.getVaultName()).toBeUndefined();
		expect(store.isConnected()).toBe(true); // still signed in
	});

	it("a removal takes the key out of the in-memory record, not just off the disk", async () => {
		// `JSON.stringify` drops `undefined` values, so the bytes look identical either way and the
		// disk cannot tell these apart. The canonical record can, and `exactOptionalPropertyTypes`
		// means "absent" and "present as undefined" are genuinely different types here.
		const m = await memStore({ tokens: { access_token: "at" }, vaultId: "v", vaultName: "n" });
		await m.store.signOut();
		expect("tokens" in m.data.read()).toBe(false);

		await m.store.unlinkVault();
		expect("vaultId" in m.data.read()).toBe(false);
		expect("vaultName" in m.data.read()).toBe(false);
	});

	it("tolerates a null initial load (fresh install)", async () => {
		// `PluginDataStore.open` is what turns an absent file into `{}` now, so this is its test as much
		// as TokenStore's — the behaviour is the same and it is still pinned.
		const store = new TokenStore(
			await PluginDataStore.open({
				load: () => Promise.resolve(null),
				save: () => Promise.resolve(),
			}),
		);
		expect(store.getClientId()).toBeUndefined();
		expect(store.isConnected()).toBe(false);
	});

	it("getDeviceId generates once and returns the same id thereafter", async () => {
		const m = await memStore();
		const store = m.store;
		const first = await store.getDeviceId();
		expect(first).toMatch(/[0-9a-f-]{36}/);
		expect(await store.getDeviceId()).toBe(first);
		expect(m.peek().deviceId).toBe(first);
	});
});
