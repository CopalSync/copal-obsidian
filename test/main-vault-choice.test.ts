// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedData } from "../src/data/plugin-data-store";
import CopalPlugin from "../src/main";
import { signInOn } from "./data/fake-plugin-data";
import { __setRequestUrl, Notice, stubApp } from "./stubs/obsidian";

/**
 * The join screen (`VaultChoiceModal`), which had no test.
 *
 * ⚠️ It is NOT "adopt-only", despite that being the shorthand this screen is usually described by.
 * `src/connect/decide.ts` says so explicitly: the screen used to offer exactly one move, so a person
 * with notes here AND notes in Copal could only replace one with the other. It now offers uploading this
 * folder as a new vault as well. What is still exact is everything else — zero vaults means no screen at
 * all, nothing is preselected, and replacing local files confirms in place with a count.
 *
 * Reached through `startSync()` because the modal is private to `main.ts`, which also means these tests
 * cover the route to it, not just its markup.
 */
const TOKENS = {
	access_token: "at",
	refresh_token: "rt",
	expires_at: Date.now() + 60 * 60 * 1000,
};

function vaultsBody(...names: string[]) {
	return {
		vaults: names.map((displayName, i) => ({
			vaultId: `vlt-${i}`,
			displayName,
			createdAt: 1,
		})),
	};
}

/**
 * Answer `GET /vaults` with this body; anything else is a hard failure so a stray call is visible.
 *
 * ⚠️ The bytes must go in `arrayBuffer`. `src/sync/request-url-fetch.ts:30` builds its `Response` from
 * that field alone — `text`/`json` are never read — so a stub that fills only those produces an empty
 * body, `res.json()` throws, and the plugin reports "could not reach Copal". Which is what it did.
 */
function serveVaults(body: unknown): void {
	const json = JSON.stringify(body);
	__setRequestUrl((p) => {
		if (p.url.includes("/vaults") && (p.method ?? "GET") === "GET") {
			return Promise.resolve({
				status: 200,
				headers: { "content-type": "application/json" },
				arrayBuffer: new TextEncoder().encode(json).buffer as ArrayBuffer,
				text: json,
				json: body,
			});
		}
		return Promise.reject(new Error(`unexpected request: ${p.method ?? "GET"} ${p.url}`));
	});
}

async function openJoinScreen(localFiles: Record<string, string>, ...vaultNames: string[]) {
	const app = stubApp(localFiles);
	const plugin = new CopalPlugin(app as never, {} as never);
	signInOn(app, TOKENS);
	await plugin.onload();
	serveVaults(vaultsBody(...vaultNames));
	// Don't await: the modal blocks on the user's choice.
	const running = (plugin as unknown as { startSync(): Promise<void> }).startSync();
	await vi.waitFor(() => {
		if (document.body.textContent === "") throw new Error("screen not up yet");
	});
	return { plugin, running, body: document.body };
}

const click = (root: ParentNode, label: string): void => {
	const b = [...root.querySelectorAll("button")].find((x) => x.textContent === label);
	if (b === undefined) {
		throw new Error(
			`no button ${JSON.stringify(label)}; found ${JSON.stringify(
				[...root.querySelectorAll("button")].map((x) => x.textContent),
			)}`,
		);
	}
	b.click();
};

afterEach(() => {
	Notice.__reset();
	document.body.empty();
	vi.restoreAllMocks();
});

describe("what the screen offers", () => {
	it("offers BOTH uploading this folder and adopting an existing vault", async () => {
		// ⚠️ The correction to the "adopt-only" shorthand. Offering only adopt meant somebody with notes
		// in both places could only destroy one set; decide.ts records that reasoning.
		const { body } = await openJoinScreen({ "mine.md": "x" }, "Research", "Archive");
		expect(body.textContent).toMatch(/Upload your existing local files to Copal/);
		expect(body.textContent).toMatch(/Adopt existing vault/);
		click(body, "Upload"); // resolve the pending modal
	});

	it("lists every vault on the account, with nothing preselected", async () => {
		const { body } = await openJoinScreen({ "mine.md": "x" }, "Research", "Archive");
		const rows = [...body.querySelectorAll(".copal-vault-row")];
		expect(rows.map((r) => r.querySelector(".copal-vault-name")?.textContent)).toEqual([
			"Research",
			"Archive",
		]);
		// No default: every row needs its own deliberate Adopt press.
		expect(rows.every((r) => [...r.querySelectorAll("button")].length === 1)).toBe(true);
		expect(body.querySelector(".is-confirming"), "nothing is mid-confirmation on open").toBe(null);
		click(body, "Upload");
	});

	it("explains how to pull a remote vault into a fresh folder", async () => {
		const { body } = await openJoinScreen({}, "Research");
		expect(body.querySelector(".copal-modal-hint")?.textContent).toMatch(
			/create a new local vault, then adopt the remote one/,
		);
		click(body, "Upload");
	});
});

describe("when the folder's vault vanished from the account", () => {
	it("says so, rather than looking like a folder that was never connected", async () => {
		// A folder whose vault was deleted elsewhere is unlinked silently and lands here. One is a setup
		// step, the other is "something you had is gone" — a person not told the second assumes the
		// plugin lost their notes.
		const app = stubApp({ "mine.md": "x" });
		const plugin = new CopalPlugin(app as never, {} as never);
		signInOn(app, TOKENS);
		await (plugin as unknown as { saveData(d: unknown): Promise<void> }).saveData({
			vaultId: "vlt-gone",
			vaultName: "Gone",
		} satisfies PersistedData);
		await plugin.onload();
		serveVaults(vaultsBody("Research"));
		void (plugin as unknown as { startSync(): Promise<void> }).startSync();
		await vi.waitFor(() => {
			if (document.body.textContent === "") throw new Error("not yet");
		});
		expect(document.body.querySelector(".copal-modal-danger")?.textContent).toMatch(
			/no longer on your account/,
		);
		expect(document.body.textContent).toMatch(/local files are untouched/i);
		click(document.body, "Upload");
	});
});

describe("adopting is confirmed in place when it would displace local files", () => {
	it("warns with the exact file count before replacing anything", async () => {
		const { body } = await openJoinScreen({ "a.md": "1", "b.md": "2", "c.md": "3" }, "Research");
		click(body, "Adopt");
		const row = body.querySelector(".copal-vault-row.is-confirming");
		expect(row, "the confirmation happens on the row, not in a nested modal").not.toBe(null);
		expect(row?.querySelector(".copal-vault-warning")?.textContent).toBe(
			"3 local files to Obsidian's trash.",
		);
		click(body, "Cancel");
	});

	it("says Obsidian's trash, never deleted — overstating it makes people abandon a safe action", async () => {
		// ObsidianVault.remove calls vault.trash(file, false): the .trash folder INSIDE the vault, which
		// exists on mobile and is recoverable.
		const { body } = await openJoinScreen({ "a.md": "1" }, "Research");
		expect(body.textContent).toMatch(/Obsidian's trash/);
		expect(body.textContent).not.toMatch(/will be deleted/i);
		click(body, "Upload");
	});

	it("singularises one file", async () => {
		const { body } = await openJoinScreen({ "only.md": "1" }, "Research");
		click(body, "Adopt");
		expect(body.querySelector(".copal-vault-warning")?.textContent).toBe(
			"1 local file to Obsidian's trash.",
		);
		click(body, "Cancel");
	});

	it("Cancel restores the row, so the screen stays usable", async () => {
		const { body } = await openJoinScreen({ "a.md": "1" }, "Research");
		click(body, "Adopt");
		expect(body.querySelector(".is-confirming")).not.toBe(null);
		click(body, "Cancel");
		expect(body.querySelector(".is-confirming"), "the row must return to its resting state").toBe(
			null,
		);
		expect(body.querySelector(".copal-vault-name")?.textContent).toBe("Research");
		// And it can be re-armed.
		click(body, "Adopt");
		expect(body.querySelector(".is-confirming")).not.toBe(null);
		click(body, "Cancel");
	});

	it("does NOT warn when there are no local files to displace", async () => {
		const { body } = await openJoinScreen({}, "Research");
		expect(body.textContent).not.toMatch(/to Obsidian's trash/);
	});
});
