import { describe, expect, it } from "vitest";
import { TokenStore } from "../../src/connect/store";
import { PluginDataStore } from "../../src/data/plugin-data-store";
import { SecretStorage } from "../stubs/obsidian";
import { memCredentials, memData, memStore } from "../data/fake-plugin-data";

const ROTATED = {
	access_token: "DUMMY-ACCESS-2",
	refresh_token: "DUMMY-REFRESH-2-ROTATED",
	expires_at: 9e15,
};

describe("TokenStore", () => {
	it("round-trips client id and tokens through this device's secret store", async () => {
		const m = await memStore();
		await m.store.completeSignIn({ access_token: "at", scope: "vault.read vault.write" }, "cid");
		expect(m.store.getClientId()).toBe("cid");
		expect(m.store.getTokens()?.access_token).toBe("at");
		expect(m.signIn()).toEqual({
			tokens: { access_token: "at", scope: "vault.read vault.write" },
			clientId: "cid",
		});
	});

	it("isConnected reflects the presence of an access token", async () => {
		const m = await memStore();
		expect(m.store.isConnected()).toBe(false);
		await m.store.completeSignIn({ access_token: "at" }, "cid");
		expect(m.store.isConnected()).toBe(true);
	});

	it("signOut() drops the sign-in but keeps the vault link (sign back in → resume)", async () => {
		const m = await memStore();
		await m.store.completeSignIn({ access_token: "at" }, "cid");
		await m.store.setVault("vlt_1", "Work");
		await m.store.signOut();
		expect(m.store.getTokens()).toBeUndefined();
		expect(m.store.getClientId()).toBeUndefined();
		expect(m.store.isConnected()).toBe(false);
		expect(m.store.getVaultId()).toBe("vlt_1"); // link kept → resume on sign-in
		// Nothing of the credential is left in the secret store, whose public API has no delete.
		expect(m.secrets.listSecrets().map((id) => m.secrets.getSecret(id))).toEqual([""]);
	});

	it("unlinkVault() drops the vault link but stays signed in (linked vault vanished)", async () => {
		const m = await memStore({ clientId: "cid", tokens: { access_token: "at" } });
		await m.store.setVault("vlt_1", "Work");
		await m.store.unlinkVault();
		expect(m.store.getVaultId()).toBeUndefined();
		expect(m.store.getVaultName()).toBeUndefined();
		expect(m.store.isConnected()).toBe(true); // still signed in
		expect("vaultId" in m.data.read()).toBe(false);
		expect("vaultName" in m.data.read()).toBe(false);
	});

	it("tolerates a null initial load (fresh install)", async () => {
		const store = new TokenStore(
			await PluginDataStore.open({
				load: () => Promise.resolve(null),
				save: () => Promise.resolve(),
			}),
			memCredentials().credentials,
		);
		expect(store.getClientId()).toBeUndefined();
		expect(store.isConnected()).toBe(false);
	});
});

/**
 * ⛔ Audit NV33: the sign-in never reaches the vault folder.
 *
 * The audit drove the real persistence and found the rotated refresh token in plain text in the bytes
 * saved to `data.json` (A1–A2), and a byte copy of that file loading as signed in on another install,
 * sending its bearer for any vault the account owns (B1–B3). These are those checks, inverted.
 */
describe("⛔ the sign-in stays on this device (NV33)", () => {
	it("no token byte is ever written to data.json, through sign-in and a refresh", async () => {
		const m = await memStore({ vaultId: "vlt_one" });
		await m.store.completeSignIn(
			{ access_token: "DUMMY-ACCESS-1", refresh_token: "DUMMY-REFRESH-1" },
			"cid",
		);
		await m.store.setTokens(ROTATED);
		await m.data.flush();

		const file = JSON.stringify(m.peek());
		for (const secret of ["DUMMY-ACCESS", "DUMMY-REFRESH", "cid"])
			expect(file).not.toContain(secret);
		expect(m.signIn()?.tokens).toEqual(ROTATED);
	});

	it("a byte copy of data.json, on another device, is signed out", async () => {
		const original = await memStore({ vaultId: "vlt_one", vaultName: "One" });
		await original.store.completeSignIn(
			{ access_token: "DUMMY-ACCESS-1", refresh_token: "DUMMY-REFRESH-1" },
			"cid",
		);
		await original.data.flush();

		// Another install receives the folder: the same bytes, its own (empty) secret store.
		const copy = memData(JSON.parse(JSON.stringify(original.peek())));
		const elsewhere = new TokenStore(await copy.open(), memCredentials().credentials);
		expect(elsewhere.isConnected()).toBe(false);
		expect(elsewhere.getTokens()).toBeUndefined();
		// The folder's link travels, so signing in there resumes the same vault.
		expect(elsewhere.getVaultId()).toBe("vlt_one");
	});

	it("a refresh that lands after sign-out creates no sign-in (backs the C14 latch)", async () => {
		const m = await memStore({
			clientId: "cid",
			tokens: { access_token: "at", refresh_token: "rt" },
		});
		await m.store.signOut();
		await m.store.setTokens(ROTATED);
		expect(m.store.isConnected()).toBe(false);
		expect(m.signIn()).toBeUndefined();
	});

	it("two vaults on one phone keep separate sign-ins in the shared store", async () => {
		const shared = new SecretStorage();
		const work = new TokenStore(await memData().open(), memCredentials(shared).credentials);
		const home = new TokenStore(await memData().open(), memCredentials(shared).credentials);
		await work.completeSignIn({ access_token: "work-at" }, "cid");
		await home.completeSignIn({ access_token: "home-at" }, "cid");
		await work.signOut();

		expect(shared.listSecrets()).toHaveLength(2);
		expect(work.isConnected()).toBe(false);
		expect(home.getTokens()?.access_token).toBe("home-at");
	});

	it("keeps its secret's id per vault, and mints a valid one when none is stored", () => {
		const { secrets, local, credentials } = memCredentials();
		credentials.setSignedIn({ tokens: { access_token: "at" }, clientId: "cid" });
		const [id] = secrets.listSecrets();
		expect(id).toMatch(/^copal-sign-in-[0-9a-f]{12}$/);
		expect(local.get("copal-sign-in")).toBe(id);
	});
});
