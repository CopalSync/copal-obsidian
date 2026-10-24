// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type CopalPlugin from "../src/main";
import { CopalSettingTab } from "../src/settings";
import { Notice, stubApp } from "./stubs/obsidian";

/**
 * `src/settings.ts` had zero test references — 180 lines containing the only route back for an install
 * that predates `offline_access`, and the only confirmation in front of a destructive disconnect.
 *
 * Driven through real DOM: the settings tab is read back by querying rendered text and clicking real
 * buttons, not by inspecting recorded calls. The previous double made that impossible — its
 * `Setting.addButton` constructed a `ButtonComponent`, invoked the callback and discarded it, so no test
 * could reach a button at all.
 */
interface FakePlugin {
	connected: boolean;
	reauth: boolean;
	vaultId: string | undefined;
	vaultName: string | undefined;
	signOutResult: "ok" | "failed";
	calls: string[];
	flowError?: Error;
}

function tabFor(state: Partial<FakePlugin> = {}) {
	const s: FakePlugin = {
		connected: true,
		reauth: false,
		vaultId: "vlt-1",
		vaultName: "My Vault",
		signOutResult: "ok",
		calls: [],
		...state,
	};
	const plugin = {
		store: {
			isConnected: () => s.connected,
			needsReauth: () => s.reauth,
			getVaultId: () => s.vaultId,
			getVaultName: () => s.vaultName,
		},
		flow: {
			start: async () => {
				s.calls.push("flow.start");
				if (s.flowError) throw s.flowError;
			},
		},
		signOut: async () => {
			s.calls.push("signOut");
			return s.signOutResult;
		},
		connectVault: async () => void s.calls.push("connectVault"),
		disconnect: async () => void s.calls.push("disconnect"),
	};
	const app = stubApp();
	const tab = new CopalSettingTab(app, plugin as unknown as CopalPlugin);
	// `display()` is sync and kicks off an async render; await a turn so the DOM exists.
	tab.display();
	return { tab, state: s, app, container: tab.containerEl };
}

/** Click the rendered button with this exact label, anywhere in the given root. */
async function click(root: ParentNode, label: string): Promise<void> {
	const button = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
	if (button === undefined) {
		const found = [...root.querySelectorAll("button")].map((b) => b.textContent);
		throw new Error(`no button labelled ${JSON.stringify(label)}; found ${JSON.stringify(found)}`);
	}
	button.click();
	await vi.waitFor(() => undefined);
}

const text = (root: ParentNode): string => (root as HTMLElement).textContent ?? "";

afterEach(() => {
	Notice.__reset();
	document.body.empty();
	vi.restoreAllMocks();
});

describe("not signed in", () => {
	it("offers a one-time-link sign in and promises no token to paste", async () => {
		const { container, state } = tabFor({ connected: false });
		await vi.waitFor(() => expect(text(container)).toMatch(/Sign in to Copal/));
		expect(text(container)).toMatch(/no token to paste/i);
		await click(container, "Log in");
		expect(state.calls).toEqual(["flow.start"]);
		expect(Notice.shown.join(" ")).toMatch(/finish in your browser/i);
	});

	it("reports a failed sign-in in fixed copy, not the raw error (G7)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { container } = tabFor({ connected: false, flowError: new Error("network down") });
		await vi.waitFor(() => expect(text(container)).toMatch(/Sign in to Copal/));
		await click(container, "Log in");
		expect(Notice.shown.join(" ")).toMatch(/Something went wrong syncing with Copal/);
		expect(Notice.shown.join(" ")).not.toMatch(/network down/);
	});

	it("shows no Disconnect control when there is nothing to disconnect from", async () => {
		const { container } = tabFor({ connected: false });
		await vi.waitFor(() => expect(text(container)).toMatch(/Sign in to Copal/));
		expect(text(container)).not.toMatch(/Disconnect/);
	});
});

describe("an install that cannot renew its sign-in", () => {
	it("offers Sign in again — the ONLY route back for a pre-offline_access install", async () => {
		// ⛔ Such an install is still `isConnected()`, so the not-signed-in branch never fires and the
		// Log in button is never shown. Without this branch the whole fix ships INERT for exactly the
		// people who have the bug.
		const { container, state } = tabFor({ reauth: true });
		await vi.waitFor(() => expect(text(container)).toMatch(/Sign in again/));
		expect(text(container)).toMatch(/can't renew itself/);
		await click(container, "Sign in again");
		expect(state.calls).toEqual(["flow.start"]);
	});

	it("does not offer it once the sign-in can renew itself", async () => {
		const { container } = tabFor({ reauth: false });
		await vi.waitFor(() => expect(text(container)).toMatch(/Connected/));
		expect(text(container)).not.toMatch(/Sign in again/);
	});
});

describe("signed in but not linked to a vault", () => {
	it("says nothing is syncing and offers both Sign out and Sync", async () => {
		const { container, state } = tabFor({ vaultId: undefined });
		await vi.waitFor(() => expect(text(container)).toMatch(/Not syncing/));
		expect(text(container)).toMatch(/not linked to a Copal vault/);
		await click(container, "Sync");
		expect(state.calls).toEqual(["connectVault"]);
	});

	it("does not claim to be Connected", async () => {
		const { container } = tabFor({ vaultId: undefined });
		await vi.waitFor(() => expect(text(container)).toMatch(/Not syncing/));
		expect(text(container)).not.toMatch(/This folder syncs to/);
	});
});

describe("connected", () => {
	it("names the vault it syncs to", async () => {
		const { container } = tabFor({ vaultName: "Research" });
		await vi.waitFor(() => expect(text(container)).toMatch(/Connected/));
		expect(text(container)).toMatch(/syncs to the Copal vault "Research"/);
	});

	it("carries the credential-storage fine print (S4)", async () => {
		// A transparency promise, not decoration: the sign-in lives in plugin data, so it travels with
		// a synced vault. `docs/subprocessors.md` is written on the basis that this is disclosed.
		const { container } = tabFor();
		await vi.waitFor(() => expect(text(container)).toMatch(/Connected/));
		const fine = container.querySelector(".copal-fineprint");
		expect(fine, "the disclosure must actually render").not.toBe(null);
		expect(fine?.textContent ?? "").toMatch(/your sign-in travels with it/i);
		expect(fine?.textContent ?? "").toMatch(/up to an hour/i);
	});

	it("says plainly when a sign-out could not be revoked, rather than reporting success", async () => {
		// ⚠️ A failed revoke still signs you out HERE, but every copy of the vault keeps a sign-in that
		// can renew itself. That has to be said, not covered by the same cheerful notice as a clean one.
		const { container, state } = tabFor({ signOutResult: "failed" });
		await vi.waitFor(() => expect(text(container)).toMatch(/Connected/));
		await click(container, "Sign out");
		expect(state.calls).toEqual(["signOut"]);
		expect(Notice.shown.join(" ")).toMatch(/was not revoked/i);
		expect(Notice.shown.join(" ")).not.toMatch(/Signed out\. Sign back in to resume\./);
	});

	it("reports a clean sign-out as clean", async () => {
		const { container } = tabFor({ signOutResult: "ok" });
		await vi.waitFor(() => expect(text(container)).toMatch(/Connected/));
		await click(container, "Sign out");
		expect(Notice.shown.join(" ")).toMatch(/Sign back in to resume/);
		expect(Notice.shown.join(" ")).not.toMatch(/was not revoked/);
	});

	it("has no plugin-name heading — Obsidian already renders the tab title", async () => {
		// A store review guideline, and it had regressed to an <h2> once before.
		const { container } = tabFor();
		await vi.waitFor(() => expect(text(container)).toMatch(/Connected/));
		expect(container.querySelector("h1, h2, h3")).toBe(null);
	});
});

describe("Disconnect is confirmed first", () => {
	it("does NOTHING when the confirmation is cancelled", async () => {
		// ⛔ The assertion that matters. Disconnect unlinks the folder and wipes local sync state, so a
		// confirm that is merely SHOWN but not honoured would be worse than none at all.
		const { container, state } = tabFor();
		await vi.waitFor(() => expect(text(container)).toMatch(/Connected/));
		await click(container, "Disconnect");
		expect(text(document.body)).toMatch(/Disconnect this folder from Copal\?/);

		await click(document.body, "Cancel");
		expect(state.calls, "a cancelled confirm must not disconnect").toEqual([]);
	});

	it("disconnects once the confirmation is accepted", async () => {
		const { container, state } = tabFor();
		await vi.waitFor(() => expect(text(container)).toMatch(/Connected/));
		await click(container, "Disconnect");
		// The modal's own CTA carries the same label; it is the one inside the opened dialog.
		const dialog = document.body.querySelector(".modal-content")?.parentElement ?? document.body;
		await click(dialog, "Disconnect");
		expect(state.calls).toEqual(["disconnect"]);
		expect(Notice.shown.join(" ")).toMatch(/Disconnected\. Your notes are kept as files\./);
	});

	it("explains that files are kept, so the confirmation is informative", async () => {
		const { container } = tabFor();
		await vi.waitFor(() => expect(text(container)).toMatch(/Connected/));
		await click(container, "Disconnect");
		expect(text(document.body)).toMatch(/Your Markdown files stay/);
		expect(text(document.body)).toMatch(/Pending edits are pushed first/);
	});
});
