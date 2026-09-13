import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import CopalPlugin from "../src/main";
import { TokenStore } from "../src/connect/store";
import type { PersistedData } from "../src/connect/store";
import type { RevokeOutcome } from "../src/connect/token-manager";

/**
 * ⛔ **THE FILE NOTHING COULD LOAD.**
 *
 * F2 (sign-out never revoked) and C14 (an in-flight refresh resurrecting the credential) both survived
 * a suite of individually-correct assertions, for one reason: the ordering that mattered lived in
 * `main.ts`, and no test imported `main.ts`. `connect/sign-out.ts` now holds the ordering and is tested
 * directly — but that only proves the unit works, not that **the Sign out button uses it**. This file
 * closes that gap by driving the real plugin class's real methods.
 *
 * It does NOT emulate Obsidian. `onload()` is never called; the handful of fields these two methods
 * touch are set directly, and everything else stays `undefined`, which the methods already tolerate
 * (`serverReachable()` answers false with no api, so the flush is skipped; `stopSync()` and
 * `settingsTab?.refresh()` are optional-chained).
 */
function makePlugin(initial: PersistedData, outcome: RevokeOutcome | Error = "revoked") {
	const calls: string[] = [];
	let data: PersistedData = { ...initial };
	const store = new TokenStore(
		() => Promise.resolve(data),
		(next) => {
			data = next;
			return Promise.resolve();
		},
	);
	// Spied rather than faked, so these are the REAL store mutations in the real order.
	const signOutSpy = vi.spyOn(store, "signOut");
	signOutSpy.mockImplementation(async () => {
		calls.push("local-delete");
		const { tokens: _dropped, ...rest } = data;
		data = rest;
	});
	const unlinkSpy = vi.spyOn(store, "unlinkVault");
	unlinkSpy.mockImplementation(async () => {
		calls.push("unlink-vault");
		const { vaultId: _v, vaultName: _n, ...rest } = data;
		data = rest;
	});

	const scopes: string[] = [];
	const tokens = {
		revokeAndAbandon: vi.fn(async (scope = "token"): Promise<RevokeOutcome> => {
			scopes.push(scope);
			calls.push("revoke");
			if (outcome instanceof Error) throw outcome;
			return outcome;
		}),
		abandon: vi.fn(async () => {
			calls.push("abandon");
		}),
	};

	const plugin = new CopalPlugin(new App() as never, {} as never);
	const internals = plugin as unknown as {
		store: TokenStore;
		tokens: typeof tokens;
		registry: { destroyAll: () => Promise<void> };
	};
	internals.store = store;
	internals.tokens = tokens;
	internals.registry = {
		destroyAll: vi.fn(async () => {
			calls.push("destroy-crdt-docs");
		}),
	};

	return { plugin, internals, calls, tokens, scopes, peek: () => data };
}

const LINKED: PersistedData = {
	clientId: "cid",
	tokens: { access_token: "at", refresh_token: "rt" },
	vaultId: "vlt-1",
	vaultName: "Mine",
};

describe("CopalPlugin.signOut", () => {
	it("revokes at the server BEFORE deleting the credential locally", async () => {
		const { plugin, calls, tokens, peek } = makePlugin(LINKED);

		expect(await plugin.signOut()).toBe("revoked");

		expect(tokens.revokeAndAbandon).toHaveBeenCalledOnce();
		// The order is the security property: the delete destroys the token revocation needs.
		expect(calls).toEqual(["revoke", "local-delete"]);
		expect(peek().tokens).toBeUndefined();
		expect(peek().vaultId).toBe("vlt-1"); // sign-out keeps the link, so signing back in resumes
	});

	/*
	 * ⛔ Sign-out is the everyday pause. Taking the CONSENT back too would be "more secure" and would put
	 * a consent screen in front of every single sign-in; the credential is dead either way.
	 */
	it("revokes the token only, leaving the consent so resuming needs no new consent screen", async () => {
		const { plugin, scopes } = makePlugin(LINKED);
		await plugin.signOut();
		expect(scopes).toEqual(["token"]);
	});

	it("signs out locally and reports failure when revocation cannot be done", async () => {
		const { plugin, calls, peek } = makePlugin(LINKED, "failed");
		expect(await plugin.signOut()).toBe("failed");
		expect(calls).toEqual(["revoke", "local-delete"]);
		expect(peek().tokens).toBeUndefined(); // signed out HERE regardless — the point of the finally
	});

	it("signs out locally even when revocation throws, and does not rethrow at the button", async () => {
		const { plugin, peek } = makePlugin(LINKED, new Error("network is gone"));
		// `clearCredential` logs and swallows: a rejected promise here would leave the settings pane
		// wedged mid-sign-out with the tokens already gone.
		expect(await plugin.signOut()).toBe("failed");
		expect(peek().tokens).toBeUndefined();
	});

	it("replaces the TokenManager, so the next sign-in is not served by an abandoned one", async () => {
		const { plugin, internals, tokens } = makePlugin(LINKED);
		await plugin.signOut();
		// `abandoned` is one-way and `reauthAnnounced` is a latch; reusing the instance would silence
		// the next expiry for the rest of the session.
		expect(internals.tokens).not.toBe(tokens);
	});
});

describe("CopalPlugin.disconnect", () => {
	/**
	 * ⛔ The ordering the vault-id keying forced. `destroyAll()` enumerates databases keyed by the LINKED
	 * vault id, so it has to run while the folder still has one. Unlinking first leaves it unable to name
	 * a single database and the wipe silently becomes a no-op, whose leftovers the next link would push
	 * into a different vault.
	 */
	it("wipes the local CRDT docs BEFORE unlinking the vault", async () => {
		const { plugin, calls, peek } = makePlugin(LINKED);

		expect(await plugin.disconnect()).toBe("revoked");

		expect(calls).toEqual(["revoke", "local-delete", "destroy-crdt-docs", "unlink-vault"]);
		expect(calls.indexOf("destroy-crdt-docs")).toBeLessThan(calls.indexOf("unlink-vault"));
		expect(peek().tokens).toBeUndefined();
		expect(peek().vaultId).toBeUndefined(); // disconnect fully unlinks
	});

	/*
	 * ⛔ Disconnect detaches the folder for good, so it takes the WHOLE grant: consent plus both token
	 * families. Revoking the token alone leaves the server reporting the grant active and the account
	 * page still listing this plugin as a connected agent — `revoke.ts` calls that not a revoke.
	 */
	it("takes the whole grant, consent included, not just the token", async () => {
		const { plugin, scopes } = makePlugin(LINKED);
		await plugin.disconnect();
		expect(scopes).toEqual(["grant"]);
	});
});
