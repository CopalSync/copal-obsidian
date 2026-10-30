// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CopalPlugin from "../src/main";
import type { Tokens } from "../src/types";
import { signInOn } from "./data/fake-plugin-data";
// `Notice` comes from the stub by relative path, not through the alias: its `shown`/`__reset`
// statics are stub-only, and tsc resolves "obsidian" to the REAL package.
import { Notice, stubApp, workspaceOf } from "./stubs/obsidian";

/**
 * ⛔ **LAYOUT-READY, FIRED FOR THE FIRST TIME.**
 *
 * `main.ts:334` defers the whole startup path to `workspace.onLayoutReady`. The previous double RECORDED
 * that callback and never ran it — with a comment saying so — so everything inside it was dead code
 * under test: the reauth notice, the connect decision, and the startup reconcile. That is also why
 * `ObsidianVault` was never executed, and therefore why its `instanceof TFile` crash stayed hidden.
 *
 * `startSync()` itself is stubbed out here. It opens sockets and walks the whole vault, and what is
 * under test is the ROUTING — which branch of layout-ready runs for which stored state. The reconcile
 * it starts is covered by the crdt suites against the engine directly, and end-to-end by
 * `test/live/two-device.live.test.ts` against the deployed gateway.
 */
async function loaded(signedIn: Tokens | null) {
	const app = stubApp({ "existing.md": "hello" });
	const plugin = new CopalPlugin(app as never, {} as never);
	if (signedIn !== null) signInOn(app, signedIn);
	await plugin.onload();
	// Replace the reconcile, keeping the decision to call it observable.
	const startSync = vi
		.spyOn(plugin as unknown as { startSync(): Promise<void> }, "startSync")
		.mockResolvedValue();
	return { plugin, app, workspace: workspaceOf(app), startSync };
}

const CONNECTED: Tokens = { access_token: "at", refresh_token: "rt" };
/** An install that signed in before `offline_access`: a token it cannot renew. */
const UNRENEWABLE: Tokens = { access_token: "at" };

beforeEach(() => Notice.__reset());

describe("the layout-ready callback", () => {
	it("is registered during onload", async () => {
		const { workspace } = await loaded(null);
		expect(
			workspace.layoutReadyCb,
			"the startup path is deferred to layout-ready, so onload must register it",
		).toBeDefined();
	});

	it("starts sync when the install is connected", async () => {
		const { workspace, startSync } = await loaded(CONNECTED);
		expect(startSync).not.toHaveBeenCalled();
		await workspace.fireLayoutReady();
		expect(startSync, "a connected install reconciles on startup").toHaveBeenCalledTimes(1);
	});

	it("does NOT start sync when the install has never connected", async () => {
		const { workspace, startSync } = await loaded(null);
		await workspace.fireLayoutReady();
		expect(startSync).not.toHaveBeenCalled();
		expect(Notice.shown, "and says nothing to a user who has not signed in").toEqual([]);
	});

	it("warns about an unrenewable sign-in but keeps syncing with it", async () => {
		// ⚠️ The point of this branch: a token that cannot be refreshed still WORKS until it expires,
		// so signing the user out would interrupt sync that is functioning right now. It must warn and
		// carry on, not disconnect.
		const { workspace, startSync } = await loaded(UNRENEWABLE);
		await workspace.fireLayoutReady();
		expect(Notice.shown.join(" ")).toMatch(/can't renew itself/);
		expect(startSync, "warning is not the same as stopping").toHaveBeenCalledTimes(1);
	});

	it("says nothing about renewal when the token can be renewed", async () => {
		const { workspace } = await loaded(CONNECTED);
		await workspace.fireLayoutReady();
		expect(Notice.shown).toEqual([]);
	});
});

describe("the vault listeners onload registers", () => {
	it("registers create, modify, delete and rename on the vault", async () => {
		const { app } = await loaded(null);
		// The double's Events actually tracks subscriptions, so this counts live handlers rather than
		// trusting a recorded call.
		const vault = app.vault as unknown as { listenerCount(name: string): number };
		for (const name of ["create", "modify", "delete", "rename"]) {
			expect(vault.listenerCount(name), `${name} must be observed`).toBe(1);
		}
	});

	it("releases them on unload — previously unprovable, since the double could not unsubscribe", async () => {
		const { plugin, app } = await loaded(null);
		const vault = app.vault as unknown as { listenerCount(name: string): number };
		expect(vault.listenerCount("modify")).toBe(1);
		(plugin as unknown as { unload(): void }).unload();
		plugin.onunload();
		expect(vault.listenerCount("modify"), "a leaked listener outlives the plugin").toBe(0);
	});
});
