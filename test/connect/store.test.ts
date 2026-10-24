import { describe, expect, it } from "vitest";
import { TokenStore } from "../../src/connect/store";
import { PluginDataStore } from "../../src/data/plugin-data-store";
import { memStore } from "../data/fake-plugin-data";

describe("TokenStore", () => {
	it("round-trips client id and tokens through the injected save", async () => {
		const m = await memStore();
		const store = m.store;
		await store.completeSignIn({ access_token: "at", scope: "vault.read vault.write" }, "cid");
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
		await store.completeSignIn({ access_token: "at" }, "cid");
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

	/*
	 * `getDeviceId` was removed by N5: the id lived in `data.json`, which travels with a synced vault, so
	 * two devices shared one. P5's echo filter then made device B discard device A's changes as its own
	 * echo. It is per-install now, and tested in `test/connect/device-id.test.ts`.
	 */
});
