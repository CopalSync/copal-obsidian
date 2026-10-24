// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedData } from "../src/data/plugin-data-store";
import CopalPlugin from "../src/main";
import { ApiError } from "../src/sync/api";
import { COPAL_SEARCH_VIEW } from "../src/ui/search-view";
import { Menu, Notice, stubApp, workspaceOf } from "./stubs/obsidian";

/**
 * The `main.ts` lifecycle G11 deferred until P5, because P5 rewrote the wiring these run against.
 *
 * Covers the surfaces the double could not reach before: the `obsidian://copal-connect` handler, both
 * `checkCallback`s, `activateSearchView`, the status indicator and its menu, and the delete/rename
 * routing between the CRDT and attachment channels.
 */
interface Internals {
	saveData(d: unknown): Promise<void>;
	protocolHandlers: Map<string, (p: Record<string, string>) => unknown>;
	commands: { id: string; name?: string; checkCallback?: (checking: boolean) => boolean }[];
	syncActive: boolean;
	crdt: unknown;
	binarySync: unknown;
	sync: unknown;
	flow: unknown;
	settingsTab: unknown;
	startSync(): Promise<void>;
	stopSync(): void;
	startBound(mode: "merge" | "adopt"): Promise<void>;
	onDelete(path: string): void;
	onRename(f: { path: string }, oldPath: string): Promise<void>;
	setStatus(s: string): void;
	showStatusMenu(e: unknown): void;
	ribbonIconEl?: HTMLElement;
	statusEl?: HTMLElement;
}

async function loaded(initial: PersistedData | null = null) {
	const app = stubApp({ "a.md": "x" });
	const plugin = new CopalPlugin(app as never, {} as never);
	const io = plugin as unknown as Internals;
	if (initial !== null) await io.saveData(initial);
	await plugin.onload();
	// The reconcile is not what these test; keep it from reaching the network.
	vi.spyOn(plugin as unknown as { startSync(): Promise<void> }, "startSync").mockResolvedValue();
	return { plugin, io, app, workspace: workspaceOf(app) };
}

const command = (io: Internals, id: string) => {
	const c = io.commands.find((x) => x.id === id);
	if (c === undefined)
		throw new Error(`no command ${id}; have ${io.commands.map((x) => x.id).join(", ")}`);
	return c;
};

afterEach(() => {
	Notice.__reset();
	document.body.empty();
	vi.restoreAllMocks();
});

describe("sync restarted in the same session", () => {
	it("startBound resumes the closed-note paging an earlier stopSync stopped", async () => {
		// Sign-out (and a dead credential) call `stopSync`, which stops paging; signing back in reaches
		// `startBound` on the same CrdtSync. Without the resume, closed notes stopped syncing until restart.
		const { io } = await loaded();
		const crdt = io.crdt as { startPaging(): void };
		io.stopSync();
		// The reconcile itself is not under test and would reach the network.
		vi.spyOn(io.sync as { start(mode: string): Promise<void> }, "start").mockResolvedValue();
		const resume = vi.spyOn(crdt, "startPaging");
		await io.startBound("merge");
		expect(resume).toHaveBeenCalledTimes(1);
	});
});

describe("the obsidian://copal-connect handler", () => {
	it("is registered, so the browser can hand the callback back", async () => {
		const { io } = await loaded();
		expect(io.protocolHandlers.has("copal-connect")).toBe(true);
	});

	it("⛔ SHOUTS when a sign-in returns no refresh_token, but still stores it", async () => {
		// ⛔ THE REGRESSION ALARM. A sign-in with no refresh token is the exact outage this plugin
		// shipped with for its whole life, and nothing noticed because nothing looked. Refusing the
		// sign-in would turn a degraded hour into a total outage, so it stores the token and shouts.
		const { io } = await loaded();
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		io.flow = { handleCallback: async () => ({ access_token: "at" }) };
		await io.protocolHandlers.get("copal-connect")?.({ code: "c", state: "s" });

		expect(err.mock.calls.flat().join(" ")).toMatch(/no refresh_token/);
		expect(err.mock.calls.flat().join(" "), "it must name what to check").toMatch(/offline_access/);
		expect(Notice.shown.join(" ")).toMatch(/can't renew itself/);
		expect(Notice.shown.join(" "), "and the sign-in still succeeds").toMatch(/Copal connected/);
	});

	it("stays quiet when the sign-in can renew itself", async () => {
		const { io } = await loaded();
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		io.flow = { handleCallback: async () => ({ access_token: "at", refresh_token: "rt" }) };
		await io.protocolHandlers.get("copal-connect")?.({ code: "c", state: "s" });
		expect(err).not.toHaveBeenCalled();
		expect(Notice.shown.join(" ")).toMatch(/Copal connected/);
		expect(Notice.shown.join(" ")).not.toMatch(/can't renew/);
	});

	it("reports a failed callback in FIXED copy, with the detail going to the console", async () => {
		// ⚠️ G7. It used to interpolate `err.message`, so a person saw "Copal connect failed: state
		// mismatch" — internal wording, naming neither the cause nor the remedy. The raw error still
		// reaches the console, which is where a bug report gets it from.
		const { io } = await loaded();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		io.flow = {
			handleCallback: async () => {
				throw new Error("state mismatch");
			},
		};
		await io.protocolHandlers.get("copal-connect")?.({ code: "c", state: "bad" });
		expect(Notice.shown.join(" ")).toMatch(/Something went wrong syncing with Copal/);
		expect(Notice.shown.join(" "), "no internal wording reaches the user").not.toMatch(
			/state mismatch/,
		);
		expect(logged.mock.calls.flat().join(" "), "the detail is not lost").toMatch(/connect failed/);
	});
});

describe("the commands are ABSENT rather than present-and-inert", () => {
	it("Sync now hides itself when this folder is not linked", async () => {
		// A command that is listed but does nothing is worse than one that is not listed: the person
		// runs it, nothing happens, and there is no explanation.
		const { io } = await loaded();
		io.sync = undefined;
		expect(command(io, "sync-now").checkCallback?.(true)).toBe(false);
	});

	it("Sync now appears and runs once linked", async () => {
		const { io } = await loaded();
		const syncNow = vi.fn().mockResolvedValue(undefined);
		io.sync = { syncNow };
		expect(command(io, "sync-now").checkCallback?.(true)).toBe(true);
		expect(syncNow, "checking must not DO it").not.toHaveBeenCalled();
		expect(command(io, "sync-now").checkCallback?.(false)).toBe(true);
		expect(syncNow).toHaveBeenCalledOnce();
	});

	it("a failing Sync now tells the user something useful, not the raw error", async () => {
		const { io } = await loaded();
		vi.spyOn(console, "error").mockImplementation(() => {});
		io.sync = { syncNow: () => Promise.reject(new ApiError(401, undefined, "sync")) };
		command(io, "sync-now").checkCallback?.(false);
		await vi.waitFor(() =>
			expect(Notice.shown.join(" ")).toMatch(/sign-in is no longer valid.*sign in again/i),
		);
		expect(Notice.shown.join(" "), "a bare 403/401 names neither cause nor remedy").not.toMatch(
			/failed: 401/,
		);
	});

	it("Search hides itself when there is nothing indexed to search", async () => {
		const { io } = await loaded();
		io.sync = undefined;
		expect(command(io, "search").checkCallback?.(true)).toBe(false);
	});

	it("the command names carry no plugin prefix — Obsidian adds it", async () => {
		// `copal-sync-now` / "Copal: Sync now" rendered as "copal:copal-sync-now" and
		// "Copal: Copal: Sync now" in the palette.
		const { io } = await loaded();
		for (const c of io.commands) {
			expect(c.id, `${c.id} must not repeat the plugin id`).not.toMatch(/^copal-/);
			expect(c.name ?? "", `${c.name} must not repeat the plugin name`).not.toMatch(/^Copal:/);
		}
	});
});

describe("activateSearchView", () => {
	it("reveals the pane that is already open rather than opening a second one", async () => {
		const { io, workspace } = await loaded();
		const leaf = { view: {} };
		workspace.leaves.push({ type: COPAL_SEARCH_VIEW, leaf });
		io.sync = { syncNow: vi.fn() };
		command(io, "search").checkCallback?.(false);
		await vi.waitFor(() => expect(workspace.revealed).toEqual([leaf]));
		expect(workspace.leaves.length, "no duplicate pane").toBe(1);
	});

	it("opens one in the right sidebar when none is open", async () => {
		const { io, workspace } = await loaded();
		io.sync = { syncNow: vi.fn() };
		command(io, "search").checkCallback?.(false);
		await vi.waitFor(() => expect(workspace.revealed.length).toBe(1));
	});
});

describe("the status indicator", () => {
	it("re-colours both the status bar and the ribbon, and keeps one state class", async () => {
		// The ribbon is the mobile-visible surface — the status bar does not render there — so a status
		// that only updated the desktop bar would leave mobile permanently showing the wrong state.
		const { io } = await loaded();
		io.setStatus("live");
		const ribbon = io.ribbonIconEl;
		expect(ribbon, "the ribbon must exist to be updated").toBeDefined();
		expect(ribbon?.classList.contains("is-live")).toBe(true);
		io.setStatus("offline");
		expect(ribbon?.classList.contains("is-live"), "stale state classes must be cleared").toBe(
			false,
		);
		expect(ribbon?.classList.contains("is-off")).toBe(true);
	});

	it("its menu shows the current state and offers Sync now", async () => {
		const { io } = await loaded();
		const syncNow = vi.fn().mockResolvedValue(undefined);
		io.sync = { syncNow };
		io.setStatus("live");
		const menus: Menu[] = [];
		const Original = Menu;
		vi.stubGlobal("__none", undefined);
		const spy = vi
			.spyOn(Original.prototype, "showAtMouseEvent")
			.mockImplementation(function (this: Menu) {
				menus.push(this);
			});
		io.showStatusMenu(new MouseEvent("click"));
		expect(spy).toHaveBeenCalled();
		const menu = menus[0];
		expect(menu?.items[0]?.title).toMatch(/^Copal: /);
		menu?.click("Sync now");
		expect(syncNow).toHaveBeenCalledOnce();
	});
});

describe("delete and rename route by channel", () => {
	function channels(io: Internals) {
		const crdt = {
			deleteLocal: vi.fn().mockResolvedValue(undefined),
			rename: vi.fn().mockResolvedValue(undefined),
		};
		const binary = {
			deleteLocal: vi.fn().mockResolvedValue(undefined),
			// The degraded rename path re-creates the new path through `onVaultChange`, which pushes.
			pushLocal: vi.fn().mockResolvedValue(undefined),
		};
		io.crdt = crdt;
		io.binarySync = binary;
		io.syncActive = true;
		return { crdt, binary };
	}

	it("a markdown delete goes to the CRDT channel", async () => {
		const { io } = await loaded();
		const { crdt, binary } = channels(io);
		io.onDelete("note.md");
		expect(crdt.deleteLocal).toHaveBeenCalledWith("note.md");
		expect(binary.deleteLocal).not.toHaveBeenCalled();
	});

	it("an attachment delete goes to the binary channel — never the CRDT one", async () => {
		// ⛔ Binaries must never enter the CRDT path. This is one of the three quarantine seams.
		const { io } = await loaded();
		const { crdt, binary } = channels(io);
		io.onDelete("assets/pic.png");
		expect(binary.deleteLocal).toHaveBeenCalledWith("assets/pic.png");
		expect(crdt.deleteLocal).not.toHaveBeenCalled();
	});

	it("nothing is deleted while sync is inactive", async () => {
		const { io } = await loaded();
		const { crdt, binary } = channels(io);
		io.syncActive = false;
		io.onDelete("note.md");
		io.onDelete("pic.png");
		expect(crdt.deleteLocal).not.toHaveBeenCalled();
		expect(binary.deleteLocal).not.toHaveBeenCalled();
	});

	it("a .md → .md rename preserves history through crdt.rename", async () => {
		// ⚠️ NOT delete + create. A note's server-side CRDT history is the thing being preserved; the
		// degraded path would throw it away and resurrect the note as a new one.
		const { io } = await loaded();
		const { crdt } = channels(io);
		await io.onRename({ path: "new.md" }, "old.md");
		expect(crdt.rename).toHaveBeenCalledWith("old.md", "new.md");
		expect(crdt.deleteLocal, "a rename is not a delete").not.toHaveBeenCalled();
	});

	it("a rename crossing the markdown/attachment boundary degrades to delete + create", async () => {
		// A binary has no server-side history to preserve, so delete-old + upload-new is correct.
		const { io } = await loaded();
		const { crdt, binary } = channels(io);
		await io.onRename({ path: "note.png" }, "note.md");
		expect(
			crdt.rename,
			"there is no shared history to preserve across the boundary",
		).not.toHaveBeenCalled();
		expect(crdt.deleteLocal, "the old markdown path is removed").toHaveBeenCalledWith("note.md");
		expect(binary.pushLocal, "and the new attachment is uploaded").toHaveBeenCalledWith("note.png");
	});

	it("an attachment → attachment rename stays on the binary channel", async () => {
		const { io } = await loaded();
		const { crdt, binary } = channels(io);
		await io.onRename({ path: "b/pic.png" }, "a/pic.png");
		expect(binary.deleteLocal).toHaveBeenCalledWith("a/pic.png");
		expect(binary.pushLocal).toHaveBeenCalledWith("b/pic.png");
		expect(crdt.rename, "a binary has no server-side history to move").not.toHaveBeenCalled();
		expect(crdt.deleteLocal).not.toHaveBeenCalled();
	});

	it("a failed rename says it will finish later, rather than looking lost", async () => {
		const { io } = await loaded();
		const { crdt } = channels(io);
		crdt.rename.mockRejectedValue(new Error("offline"));
		await io.onRename({ path: "new.md" }, "old.md");
		expect(Notice.shown.join(" ")).toMatch(/will finish syncing when you're back online/);
	});

	it("a failed delete says it is queued, not that it failed", async () => {
		const { io } = await loaded();
		const { crdt } = channels(io);
		crdt.deleteLocal.mockRejectedValue(new Error("offline"));
		io.onDelete("note.md");
		await vi.waitFor(() =>
			expect(Notice.shown.join(" ")).toMatch(/will finish deleting on the server/),
		);
	});
});
