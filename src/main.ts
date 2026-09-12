import type { EditorView } from "@codemirror/view";
import {
	type App,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	setIcon,
	setTooltip,
	type TAbstractFile,
} from "obsidian";
import { decideConnect } from "./connect/decide";
import { ConnectFlow } from "./connect/flow";
import { CrdtSync } from "./crdt/crdt-sync";
import { EditorBinding } from "./crdt/editor-binding";
import { LocalDocStore } from "./crdt/local-doc-store";
import { LocalNoteRegistry } from "./crdt/local-note-registry";
import { type PersistedData, TokenStore } from "./connect/store";
import { type ReauthReason, TokenManager } from "./connect/token-manager";
import { CopalSettingTab } from "./settings";
import { ApiError, type SearchHit, type SearchMode, SyncApi, type Vault } from "./sync/api";
import { type BinaryData, BinaryCursor } from "./sync/binary-cursor";
import { BinarySync, isAttachmentPath } from "./sync/binary-sync";
import { ObsidianBinaryVault } from "./sync/binary-vault";
import { SyncClient } from "./sync/live";
import { type MutationData, MutationQueue } from "./sync/mutation-queue";
import { ObsidianVault } from "./sync/obsidian-vault";
import { requestUrlFetch } from "./sync/request-url-fetch";
import { safePath } from "./sync/safe-path";
import { type SyncData, SyncState } from "./sync/state";
import { openExternal } from "./ui/external-link";
import { COPAL_SEARCH_VIEW, CopalSearchView } from "./ui/search-view";
import { STATUS_META, type SyncStatus } from "./ui/status";

/** The real Copal logo — the faceted-e amber shard (from copal-web/public/copal-gem.svg), as polygon
 *  data so it's built via the DOM (`createSvg`) rather than `innerHTML` (an Obsidian review-guideline). */
const GEM_POLYGONS: { points: string; fill: string }[] = [
	{ points: "210,230 152,264 104,308 130,340", fill: "#F6BE50" },
	{ points: "210,230 262,204 220,360 130,340", fill: "#FCC85E" },
	{ points: "262,204 330,242 372,322 220,360", fill: "#EA9E2A" },
	{ points: "330,242 402,268 438,300 372,322", fill: "#DD8C1C" },
];

/** Build the amber-shard SVG into `parent` using Obsidian's namespaced `createSvg` DOM helper (no innerHTML). */
function renderGem(parent: HTMLElement): void {
	const svg = parent.createSvg("svg", {
		attr: { viewBox: "84 184 374 196", "aria-hidden": "true" },
	});
	const g = svg.createSvg("g", { attr: { "shape-rendering": "geometricPrecision" } });
	for (const { points, fill } of GEM_POLYGONS) g.createSvg("polygon", { attr: { points, fill } });
}

/** Verbose CRDT logging is opt-in via `localStorage['copal-debug'] = '1'` — off by default (no console spam). */
function debugEnabled(): boolean {
	try {
		return globalThis.localStorage?.getItem("copal-debug") === "1";
	} catch {
		return false;
	}
}

/** Presence palette for human devices (the agent keeps its brand amber). A stable per-device colour so
 *  concurrent devices are distinguishable in the editor. Amber is deliberately excluded (agent-only). */
const PRESENCE_COLORS = ["#5B8DEF", "#2FB67C", "#A66BEF", "#E85D9E", "#22A7C7", "#E0603A"];
function colorFromId(id: string): string {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
	return PRESENCE_COLORS[h % PRESENCE_COLORS.length] as string;
}

export default class CopalPlugin extends Plugin {
	store!: TokenStore;
	flow!: ConnectFlow;
	private tokens!: TokenManager;
	/** Once per session: a burst of 401s must not become a burst of notices. */
	private reauthPrompted = false;
	sync: SyncClient | undefined;
	crdt: CrdtSync | undefined;
	private vault: ObsidianVault | undefined;
	private readonly editorBinding = new EditorBinding();
	private deviceId = "";
	private syncActive = false;
	private settingsTab: CopalSettingTab | undefined;
	private api: SyncApi | undefined;
	private syncState: SyncState | undefined;
	private mutationQueue: MutationQueue | undefined;
	private binarySync: BinarySync | undefined;
	private binaryCursor: BinaryCursor | undefined;
	private binaryQueue: MutationQueue | undefined;
	private registry: LocalNoteRegistry | undefined;
	private readonly warnedNames = new Set<string>();
	private statusEl: HTMLElement | undefined;
	private syncIconEl: HTMLElement | undefined;
	private ribbonIconEl: HTMLElement | undefined;
	private lastStatusLabel = "not connected";

	override async onload(): Promise<void> {
		this.store = new TokenStore(
			() => this.loadData() as Promise<PersistedData | null>,
			(data) => this.saveData(data),
		);
		this.flow = new ConnectFlow({
			f: requestUrlFetch,
			store: this.store,
			openUrl: (url) => openExternal(this.app, url),
			randomState: () => crypto.randomUUID(),
		});

		this.tokens = new TokenManager({
			f: requestUrlFetch,
			store: this.store,
			onReauthRequired: (reason) => this.onReauthRequired(reason),
		});

		// Sync stack. SyncState persists under the `sync` key of data.json, alongside the connect tokens;
		// both read-modify-write the whole record, so they coexist.
		const api = new SyncApi({
			f: requestUrlFetch,
			getToken: () => this.tokens.getValid(),
			getVaultId: () => this.store.getVaultId(),
			onUnauthorized: (used) => this.tokens.refreshAfterUnauthorized(used),
		});
		this.api = api;
		const syncState = new SyncState(
			async () =>
				((await this.loadData()) as (PersistedData & { sync?: SyncData }) | null)?.sync ?? null,
			async (sync) => {
				const data = ((await this.loadData()) as PersistedData | null) ?? {};
				await this.saveData({ ...data, sync });
			},
		);
		await syncState.init();
		this.syncState = syncState;
		// Durable pending-mutation queue (offline/failed deletes), under the `pending` key of data.json.
		const mutationQueue = new MutationQueue(
			async () =>
				((await this.loadData()) as (PersistedData & { pending?: MutationData }) | null)?.pending ??
				null,
			async (pending) => {
				const data = ((await this.loadData()) as PersistedData | null) ?? {};
				await this.saveData({ ...data, pending });
			},
		);
		await mutationQueue.init();
		this.mutationQueue = mutationQueue;
		this.deviceId = await this.store.getDeviceId();
		const vault = new ObsidianVault(this.app);
		this.vault = vault;
		// Attachment (non-`.md`) sync: file-level last-writer-wins, keyed on the R2 etag. Its cursor persists
		// under the `binary` key of data.json and its durable delete queue under `binaryPending` — both coexist
		// with `sync`/`pending` via the same read-modify-write idiom.
		const binaryCursor = new BinaryCursor(
			async () =>
				((await this.loadData()) as (PersistedData & { binary?: BinaryData }) | null)?.binary ??
				null,
			async (binary) => {
				const data = ((await this.loadData()) as PersistedData | null) ?? {};
				await this.saveData({ ...data, binary });
			},
		);
		await binaryCursor.init();
		this.binaryCursor = binaryCursor;
		const binaryQueue = new MutationQueue(
			async () =>
				((await this.loadData()) as (PersistedData & { binaryPending?: MutationData }) | null)
					?.binaryPending ?? null,
			async (binaryPending) => {
				const data = ((await this.loadData()) as PersistedData | null) ?? {};
				await this.saveData({ ...data, binaryPending });
			},
		);
		await binaryQueue.init();
		this.binaryQueue = binaryQueue;
		const binarySync = new BinarySync({
			api,
			files: new ObsidianBinaryVault(this.app),
			cursor: binaryCursor,
			queue: binaryQueue,
			log: (m) => {
				if (debugEnabled()) console.debug(`[copal binary] ${m}`);
			},
		});
		this.binarySync = binarySync;
		// Local-first: every note is a persisted local Y.Doc (IndexedDB); the registry hands one out per path.
		const registry = new LocalNoteRegistry(new LocalDocStore("vault"), vault);
		this.registry = registry;
		// Register the CM6 compartment once; it's reconfigured per note as the binding attaches/detaches.
		this.registerEditorExtension([this.editorBinding.extension()]);
		this.crdt = new CrdtSync({
			api,
			registry,
			vault,
			queue: mutationQueue,
			binarySync,
			bind: (peer) => {
				// Give the human a presence identity so yCollab labels the local user and the agent's caret
				// reads as distinct. A stable per-device colour distinguishes concurrent devices; the agent
				// keeps amber. Set before attaching; the Awareness heartbeat keeps it fresh for peers.
				const color = colorFromId(this.deviceId);
				peer.awareness.setLocalStateField("user", { name: "You", color, colorLight: `${color}33` });
				const view = this.activeEditorView();
				if (view) this.editorBinding.attach(view, peer.doc.getText("content"), peer.awareness);
			},
			unbind: () => {
				const view = this.activeEditorView();
				if (view) this.editorBinding.detach(view);
			},
			// The live editor buffer for `path`, ONLY when it's the note currently open (else null) — so a
			// brand-new note's unsaved keystrokes are captured into the doc before materialize can wipe them.
			readActiveText: (path) => {
				const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!mdView || mdView.file?.path !== path) return null;
				return this.activeEditorView()?.state.doc.toString() ?? null;
			},
			log: (m) => {
				if (debugEnabled()) console.debug(`[copal crdt] ${m}`);
			},
		});
		// Desktop status bar: the amber shard + a lucide sync-state icon. Obsidian mobile does NOT render the
		// status bar, so the ribbon icon below is the mobile-visible surface for the same state + menu.
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("copal-status");
		renderGem(this.statusEl.createSpan({ cls: "copal-gem" }));
		this.syncIconEl = this.statusEl.createSpan({ cls: "copal-sync" });
		this.registerDomEvent(this.statusEl, "click", (evt) => this.showStatusMenu(evt));
		// Ribbon icon — visible on BOTH desktop and mobile (the only sync-status surface on mobile). Reflects
		// the current state and opens the same status menu on click/tap.
		this.ribbonIconEl = this.addRibbonIcon("cloud-off", "Copal", (evt) => this.showStatusMenu(evt));
		this.ribbonIconEl.addClass("copal-ribbon");
		this.setStatus("idle");
		this.sync = new SyncClient(api, this.crdt, syncState, (s) => this.setStatus(s));

		// The magic-link sign-in redirects to obsidian://copal-connect?code=…&state=… — caught here.
		this.registerObsidianProtocolHandler("copal-connect", async (params) => {
			try {
				const tokens = await this.flow.handleCallback({
					code: params.code,
					state: params.state,
					error: params.error,
				});
				/*
				 * ⛔ **THE REGRESSION ALARM.** A sign-in that returns no refresh token is the exact
				 * outage this plugin shipped with for its whole life, and nothing noticed because
				 * nothing looked. If `offline_access` ever stops being granted — a scope config change,
				 * a resource row with a non-null `allowed_scopes` — this is where it becomes visible.
				 *
				 * Deliberately not a throw: refusing the sign-in would turn a degraded hour into a total
				 * outage. Store the token and shout.
				 */
				if (!tokens.refresh_token) {
					console.error(
						"[copal] sign-in returned no refresh_token. This session expires in about an hour and cannot renew. Check that SCOPE requests offline_access and that the authorization server still grants it.",
					);
					new Notice(
						"Copal: signed in, but this session can't renew itself and will stop working in about an hour. Please report this.",
						12000,
					);
				}
				new Notice("Copal connected ✓");
				await this.settingsTab?.refresh();
				void this.startSync(); // fresh bind → the connect flow selects the vault (create vs pull)
			} catch (err) {
				new Notice(`Copal connect failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});

		this.addCommand({
			id: "copal-sync-now",
			name: "Copal: Sync now",
			callback: () => {
				void this.sync?.syncNow().catch((err: unknown) => {
					new Notice(`Copal sync failed: ${err instanceof Error ? err.message : String(err)}`);
				});
			},
		});

		// "Search my vault by meaning" pane — humans get the same server-side vector index the agent uses.
		this.registerView(
			COPAL_SEARCH_VIEW,
			(leaf) =>
				new CopalSearchView(leaf, {
					searchVault: (q, mode) => this.searchVault(q, mode),
					isConnected: () => this.store.isConnected(),
					hasVault: async () => (await this.store.getVaultId()) !== undefined,
					openNote: (path) => void this.app.workspace.openLinkText(path, "", false),
				}),
		);
		this.addCommand({
			id: "copal-search",
			name: "Copal: Search my vault by meaning",
			callback: () => void this.activateSearchView(),
		});
		// A ribbon icon so the pane is reachable on mobile too (where the status bar doesn't render).
		this.addRibbonIcon("search", "Copal Search", () => void this.activateSearchView());

		// Watch local edits to non-active notes and push them into their Y.Doc (transient connect). The
		// active note is owned by the live CM6 binding (ignored here). Obsidian fires a single `rename`
		// event (not delete+create); it's routed through `onRename` below so the active note moves its live
		// socket to the new path instead of re-pushing the deleted old path.
		this.registerEvent(this.app.vault.on("create", (f) => this.onVaultChange(f)));
		this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultChange(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => this.onDelete(f.path)));
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => void this.onRename(f, oldPath)));

		// Live CRDT sync for the active note. Opening a note connects its Y.Doc + binds the editor.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!this.syncActive || !file || file.extension !== "md") return;
				// A control char in the filename (e.g. a newline from a shared social post) can't sync — tell the
				// user (once per name) to rename it, instead of silently not syncing. `crdt.open` skips it either way.
				if (safePath(file.path) === null) {
					this.warnUnsyncableName(file.path);
					return;
				}
				void this.crdt?.open(file.path);
			}),
		);

		this.settingsTab = new CopalSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		// Defer the startup reconcile — which iterates the whole vault and can write/trash files — until the
		// layout is ready, so it never mutates files during Obsidian's initial vault load. Fires immediately
		// if the layout is already ready (runtime enable). The watcher gate (`syncActive`) stays false until
		// `startBound`, so the `create` replays Obsidian fires for existing files at startup are ignored.
		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				/*
				 * An install signed in before `offline_access` holds a token that cannot be renewed. It
				 * still works until it expires, so do NOT sign them out — interrupting sync that is
				 * working right now would be gratuitous. Say it once and let Settings offer the button.
				 */
				if (await this.store.needsReauth()) {
					new Notice(
						"Copal: this sign-in can't renew itself and will stop working soon. Open Settings → Copal and choose Sign in again.",
						10000,
					);
				}
				if (await this.store.isConnected()) await this.startSync();
			})();
		});
	}

	override onunload(): void {
		this.stopSync();
	}

	/** Search the connected vault against the server-side index (the search pane). Throws if no vault is
	 *  linked, so the pane can show a connect prompt. `limit` 50 is generous for a sidebar result list. */
	async searchVault(query: string, mode: SearchMode): Promise<SearchHit[]> {
		if (!this.api || !(await this.store.isConnected())) {
			throw new Error("Copal is not connected");
		}
		return this.api.search(query, { mode, limit: 50 });
	}

	/** Reveal the search pane if it's open, else open it in the right sidebar. */
	private async activateSearchView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(COPAL_SEARCH_VIEW);
		if (existing[0]) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: COPAL_SEARCH_VIEW, active: true });
			await this.app.workspace.revealLeaf(leaf);
		}
	}

	private onDelete(path: string): void {
		if (!this.syncActive) return;
		const notifyOffline = (err: unknown) => {
			// A failed server delete keeps the file (no orphan/resurrect) and is durably QUEUED — it'll sync
			// automatically when back online (no manual action / reload needed).
			new Notice(
				`Copal: ${path} will finish deleting on the server when you're back online. ` +
					`(${err instanceof Error ? err.message : String(err)})`,
			);
		};
		if (this.isSyncable(path)) {
			void this.crdt?.deleteLocal(path).catch(notifyOffline);
			return;
		}
		if (isAttachmentPath(path)) void this.binarySync?.deleteLocal(path).catch(notifyOffline);
	}

	/**
	 * A rename fires a single Obsidian `rename` event. A `.md`→`.md` rename routes through the unified,
	 * history-preserving `crdt.rename` (server move + local lineage transfer; it tears down an active note's
	 * old socket itself). Any other rename — a binary↔binary move, or one that crosses the `.md`/attachment
	 * boundary — degrades to a delete of the old path and/or a create of the new on whichever channel applies
	 * (`onDelete`/`onVaultChange` route by type). A binary has no server-side history to preserve, so
	 * delete-old + upload-new is the right move.
	 */
	private async onRename(f: TAbstractFile, oldPath: string): Promise<void> {
		if (!this.syncActive) return;
		if (this.isSyncable(oldPath) && this.isSyncable(f.path)) {
			try {
				await this.crdt?.rename(oldPath, f.path);
			} catch (err) {
				new Notice(
					`Copal: rename ${oldPath} → ${f.path} will finish syncing when you're back online. ` +
						`(${err instanceof Error ? err.message : String(err)})`,
				);
			}
			return;
		}
		if (this.isSyncable(oldPath) || isAttachmentPath(oldPath)) this.onDelete(oldPath); // old path gone
		if (this.isSyncable(f.path) || isAttachmentPath(f.path)) this.onVaultChange(f); // new path created
	}

	private isSyncable(path: string): boolean {
		return path.endsWith(".md");
	}

	/** Tell the user (once per name) that a file can't sync because its name has an invalid character
	 *  (e.g. a line break from a shared social post) — so the failure is actionable, not a silent mystery. */
	private warnUnsyncableName(path: string): void {
		if (this.warnedNames.has(path)) return;
		this.warnedNames.add(path);
		new Notice(
			`Copal: "${path}" cannot sync. Its name contains an invalid character, such as a line break. ` +
				`Rename it to sync.`,
			8000,
		);
	}

	private onVaultChange(file: TAbstractFile): void {
		if (!this.syncActive) return;
		if (this.isSyncable(file.path)) {
			// The active note is owned by the CM6 editor binding (Obsidian saves it). Every other note's local
			// edit is read + applied as an op to its persisted Y.Doc, then op-synced.
			if (this.crdt?.ownsPath(file.path)) return;
			void this.pushLocalChange(file.path);
			return;
		}
		// A non-`.md` attachment → the file-level last-writer-wins channel (never the text CRDT).
		if (isAttachmentPath(file.path)) {
			void this.binarySync?.pushLocal(file.path).catch((err: unknown) => {
				if (debugEnabled()) console.debug(`[copal binary] push failed for ${file.path}: ${err}`);
			});
		}
	}

	private async pushLocalChange(path: string): Promise<void> {
		if (!this.vault) return;
		let text: string;
		try {
			if (!(await this.vault.exists(path))) return; // deletion → file-level (P5)
			text = await this.vault.read(path);
		} catch {
			return;
		}
		await this.crdt?.onLocalChange(path, text);
	}

	/** The active note's underlying CodeMirror 6 view (Obsidian's `Editor.cm`), for the Y.Text binding. */
	private activeEditorView(): EditorView | undefined {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view ? (view.editor as unknown as { cm?: EditorView }).cm : undefined;
	}

	/** Stop pushing + pull-syncing + CRDT (disconnect / unload). Clears the watcher gate. */
	stopSync(): void {
		this.syncActive = false;
		void this.crdt?.close();
		this.sync?.stop();
	}

	/**
	 * Sign out but **keep the vault link**: flush pending edits up first (never lose data), stop syncing, and
	 * drop only the tokens. The `.md` files, the sync cursor, and the local CRDT docs all stay, so signing back
	 * in resumes this same vault exactly as it was — the everyday pause/re-auth. (Adopting a *different* vault
	 * is a fresh, unlinked folder's job.) The flush is skipped when the server is unreachable (dead sockets);
	 * the `.md` files are the safety net.
	 */
	async signOut(): Promise<void> {
		if (await this.serverReachable()) {
			try {
				await this.crdt?.flushAll();
			} catch (err) {
				console.warn(`[copal] sign-out flush failed: ${err instanceof Error ? err.message : err}`);
			}
		}
		this.stopSync();
		await this.store.signOut(); // drop tokens only — the vault link is kept for resume
		await this.settingsTab?.refresh();
	}

	/**
	 * Fully detach this folder from Copal: flush pending edits up, stop syncing, sign out **and unlink the
	 * vault** + wipe the local sync state (cursor + persisted CRDT docs). The `.md` files stay. Unlike sign-out,
	 * the next login sees an unlinked folder → the adopt screen (re-adopt this vault or a different one).
	 */
	async disconnect(): Promise<void> {
		if (await this.serverReachable()) {
			try {
				await this.crdt?.flushAll();
			} catch (err) {
				console.warn(
					`[copal] disconnect flush failed: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
		this.stopSync();
		await this.store.signOut(); // drop tokens
		await this.resetLocalVaultState(); // unlink + wipe cursor + CRDT docs (keeps .md)
		await this.settingsTab?.refresh();
	}

	/**
	 * Abandon a linked vault that no longer exists on the account (deleted, or a different account after
	 * sign-in): unlink it and wipe the stale local sync state — the cursor + persisted CRDT docs — so the next
	 * connect starts clean. The `.md` files are untouched.
	 */
	private async resetLocalVaultState(): Promise<void> {
		await this.store.unlinkVault();
		await this.syncState?.reset();
		await this.mutationQueue?.reset(); // drop queued deletes so they can't fire against the next vault
		await this.binaryCursor?.reset(); // drop the attachment etag cursor so it can't bleed into the next vault
		await this.binaryQueue?.reset(); // drop queued binary deletes
		await this.registry?.destroyAll();
	}

	/** Quick liveness probe (bounded) so `signOut` only sync-flushes when the server is actually reachable. */
	private async serverReachable(): Promise<boolean> {
		if (!this.api) return false;
		try {
			await Promise.race([
				this.api.listVaults(),
				new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
			]);
			return true;
		} catch {
			return false;
		}
	}

	/** Re-open the connect/adopt flow — the settings "Adopt" button, for when you're signed in but this folder
	 *  isn't linked to a vault yet (you closed the adopt screen). */
	async connectVault(): Promise<void> {
		await this.startSync();
	}

	/**
	 * The one connect path, run after sign-in / on reload. Lists the account's vaults once, then:
	 *  - **linked & the vault still exists** → resume it (merge), exactly as it was — no screen;
	 *  - **linked but the vault is gone** (deleted / different account) → wipe the stale local state and treat
	 *    this folder as unlinked;
	 *  - **unlinked, zero vaults** → this folder becomes the first: create a vault named after it + push up;
	 *  - **unlinked, ≥1 vault** → the adopt screen: pick one to pull down (remote-wins; local files → trash).
	 */
	private async startSync(): Promise<void> {
		try {
			if (!this.api || !this.vault) return;
			let vaults: Vault[];
			try {
				vaults = await this.api.listVaults();
			} catch (err) {
				/*
				 * ⛔ **SAY WHAT ACTUALLY WENT WRONG.** This used to catch everything and report
				 * "couldn't reach the server", so a 401, a 403, a 500 and a genuinely unreachable
				 * network all produced one sentence that named the wrong cause for three of them.
				 * `listVaults` throws with the status in it and that was being thrown away, leaving
				 * nobody — user or developer — able to tell an expired session from a dead connection.
				 *
				 * ⚠️ Nothing in this plugin reaches Sentry. It runs on the user's device, reports to
				 * no backend of ours, and a failure here is invisible to us unless the person reads it
				 * out. That makes the on-screen text the ONLY diagnostic there is, which is exactly
				 * why it has to carry the reason.
				 */
				this.setStatus("offline");
				/*
				 * ⛔ WHAT A PERSON CAN ACT ON, NOT THE STATUS CODE. A raw "401" was shown here briefly
				 * and it is a developer artefact: somebody whose session expired cannot do anything
				 * with a number. The status still reaches the console for whoever is debugging.
				 */
				console.error("Copal: listVaults failed", err);
				const status = err instanceof ApiError ? err.status : undefined;
				new Notice(
					status === 401 || status === 403
						? "Copal: your sign-in is no longer valid. Sign out in settings and sign in again."
						: "Copal: could not reach Copal. Check your connection and try again.",
					8000,
				);
				return;
			}
			let vanished = false;
			const vaultId = await this.store.getVaultId();
			if (vaultId) {
				if (vaults.some((v) => v.vaultId === vaultId)) {
					await this.startBound("merge"); // linked & present → resume, just as it was
					return;
				}
				// The vault this folder was syncing with is gone from the account. Unlink and clear the
				// stale local state, but REMEMBER WHY so the screen below can say it.
				await this.resetLocalVaultState();
				vanished = true;
			}
			// Unlinked folder: the first vault → create + push; otherwise the adopt screen.
			if (decideConnect(vaults).kind === "create") {
				await this.linkNewVault(this.app.vault.getName());
				return;
			}
			const localFileCount = (await this.vault.list()).length;
			const chosen = await new VaultChoiceModal(this.app, vaults, localFileCount, vanished).ask();
			if (chosen?.kind === "create") {
				/*
				 * ⛔ THE PLAN CAP IS A LIKELY OUTCOME HERE, NOT AN EXCEPTIONAL ONE. Solo includes one
				 * vault, so anybody on Solo who already has one and picks Upload hits it — and this
				 * screen is shown precisely BECAUSE they already have one. Left to the outer catch it
				 * surfaced as "Copal sync failed: request failed: 403", which names neither the cause
				 * nor the way forward.
				 *
				 * The gateway sends `VAULT_LIMIT_REACHED` as a machine-readable code for exactly this,
				 * so it is read rather than inferred from the status. The screen reopens afterwards:
				 * adopting is still available and they are still mid-task.
				 */
				try {
					await this.linkNewVault(this.app.vault.getName());
				} catch (err) {
					if (err instanceof ApiError && err.code === "VAULT_LIMIT_REACHED") {
						new Notice("Your plan includes one vault. Adopt it, or upgrade at copal.uk.", 8000);
						await this.startSync();
						return;
					}
					throw err;
				}
				return;
			}
			if (!chosen) {
				// Signed in but no vault adopted → nothing to sync. Go idle (not "reconnecting") and let settings
				// offer Sign out / Adopt. Nothing is started, so no sync is attempted in this state.
				this.setStatus("idle");
				await this.settingsTab?.refresh();
				new Notice("Copal: choose how to sync this folder to start.");
				return;
			}
			await this.store.setVault(chosen.vault.vaultId, chosen.vault.displayName);
			await this.startBound("adopt"); // pull the chosen vault down (remote-wins; local files → trash)
		} catch (err) {
			this.setStatus("offline");
			new Notice(`Copal sync failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Obsidian-first: create a Copal vault named after this Obsidian vault, link it, push local notes up. */
	private async linkNewVault(folder: string): Promise<void> {
		if (!this.api) return;
		const created = await this.api.createVault(folder);
		await this.store.setVault(created.vaultId, created.displayName);
		await this.startBound("merge");
	}

	/** Start the sync engine for the now-linked vault in `mode`, bind the active editor, refresh settings. */
	private async startBound(mode: "merge" | "adopt"): Promise<void> {
		// The vault is already linked (the caller committed `setVault`) — reflect the connected state in settings
		// NOW, before the initial reconcile. An adopt downloads every note in the vault, which can take seconds on
		// mobile; without this the settings pane sits on the stale "No vault adopted" screen until sync finishes,
		// reading as a failed adopt. The status indicator shows sync progress in the meantime.
		await this.settingsTab?.refresh();
		await this.sync?.start(mode);
		this.syncActive = true;
		await this.settingsTab?.refresh();
		const active = this.app.workspace.getActiveFile();
		if (active && active.extension === "md") void this.crdt?.open(active.path);
	}

	/**
	 * The credential is dead. Stop, and say so.
	 *
	 * ⛔ **`stopSync()` IS THE POINT OF THIS METHOD.** Neither socket ever gives up on its own:
	 * `SyncClient.scheduleReconnect` re-fires every 3s forever and `WsTransport` backs off to a 15s
	 * cap and then keeps going, both swallowing the ticket 401 that caused them. That is how one
	 * expired token produced 6550 requests in a week while the UI said nothing worse than "offline".
	 *
	 * Sign-out keeps the vault link, so signing back in resumes the same vault with no adopt screen.
	 */
	private onReauthRequired(reason: ReauthReason): void {
		if (this.reauthPrompted) return;
		this.reauthPrompted = true;
		void (async () => {
			this.stopSync();
			await this.store.signOut();
			this.setStatus("idle");
			await this.settingsTab?.refresh();
			new Notice(
				reason === "revoked"
					? "Copal: this vault's access was revoked. Sign in again from Settings."
					: "Copal: your sign-in has expired. Sign in again from Settings.",
				10000,
			);
		})();
	}

	private setStatus(status: SyncStatus): void {
		const meta = STATUS_META[status];
		this.lastStatusLabel = meta.label;
		// Desktop status bar.
		const icon = this.syncIconEl;
		if (this.statusEl && icon) {
			icon.removeClass("is-off", "is-sync", "is-live");
			icon.addClass(meta.cls);
			setIcon(icon, meta.icon);
			setTooltip(this.statusEl, `Copal: ${meta.label}`, { placement: "top" });
		}
		// Ribbon (the mobile-visible surface) — null-guarded so an early status can't abort onload. The label
		// stays a plain "Copal" (set at creation): the icon colour shows the state, and clicking opens the
		// status menu. (On mobile the "…" menu shows the creation label, which a later tooltip wouldn't update.)
		const ribbon = this.ribbonIconEl;
		if (ribbon) {
			ribbon.removeClass("is-off", "is-sync", "is-live");
			ribbon.addClass(meta.cls);
			setIcon(ribbon, meta.icon);
		}
	}

	/** Clicking the status shows the current state + a Sync-now action. */
	private showStatusMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle(`Copal: ${this.lastStatusLabel}`).setDisabled(true));
		menu.addItem((item) =>
			item
				.setTitle("Sync now")
				.setIcon("refresh-cw")
				.onClick(() => {
					void this.sync?.syncNow().catch((err: unknown) => {
						new Notice(`Copal sync failed: ${err instanceof Error ? err.message : String(err)}`);
					});
				}),
		);
		menu.showAtMouseEvent(evt);
	}
}

/**
 * THE ONE SCREEN FOR CONNECTING AN UNLINKED FOLDER, and it offers every move there is.
 *
 * ⚠️ **It used to offer ONE: adopt.** If the account already had a vault, the only thing this folder
 * could do was be replaced by one — so somebody with notes here and notes in Copal had no way to
 * keep both, and no way to push these up as a second vault. The rule was deliberate once and it was
 * wrong; there are three things a person can sensibly want and this now says all three, in the order
 * they are likely to want them:
 *
 *   1. Upload what is here. Makes a new Copal vault from this folder. Nothing is lost.
 *   2. Use a vault they already have. Replaces this folder. Destructive, so it confirms in place.
 *   3. Keep both. Not something this screen can do — it is a second Obsidian vault — so it is said
 *      plainly rather than left to be worked out.
 *
 * ⛔ The confirm for (2) is INLINE. A second Modal on top of this one closes it on Obsidian mobile,
 * which resolves this promise with nothing chosen and makes the button look dead. That shipped.
 */
type VaultChoice = { kind: "create" } | { kind: "adopt"; vault: Vault };

class VaultChoiceModal extends Modal {
	private chosen: VaultChoice | undefined;
	private resolve: ((v: VaultChoice | undefined) => void) | undefined;

	constructor(
		app: App,
		private readonly vaults: Vault[],
		private readonly localFileCount: number,
		/** True when this folder WAS linked and its vault no longer exists on the account. */
		private readonly vanished: boolean = false,
	) {
		super(app);
	}

	ask(): Promise<VaultChoice | undefined> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Sync" });

		/*
		 * ⚠️ SAY WHY THEY ARE HERE. A folder whose vault was deleted elsewhere is unlinked silently
		 * and lands on this screen looking like a folder that was never connected. The difference
		 * matters: one is a setup step, the other is "something you had is gone", and a person who is
		 * not told the second will assume the plugin lost their notes.
		 */
		if (this.vanished) {
			contentEl.createEl("p", {
				cls: "copal-modal-danger",
				text: "The vault this folder was syncing with is no longer on your account. Your local files are untouched.",
			});
		}

		const up = contentEl.createDiv({ cls: "copal-choice" });
		up.createSpan({ text: "Upload your existing local files to Copal" });
		const upBtn = up.createEl("button", { text: "Upload", cls: "mod-cta" });
		upBtn.onclick = () => {
			this.pick({ kind: "create" });
		};

		contentEl.createEl("p", { cls: "copal-choice-or", text: "OR" });
		contentEl.createEl("p", { cls: "copal-choice-title", text: "Adopt existing vault" });
		if (this.localFileCount > 0) {
			/*
			 * ⚠️ "Obsidian's trash", not "deleted". `ObsidianVault.delete` calls
			 * `app.vault.trash(file, false)` — the `.trash` FOLDER INSIDE THE VAULT, which exists on
			 * mobile and is recoverable. Saying "deleted" would be shorter and would overstate the
			 * damage, and overstating it makes people abandon a safe action.
			 */
			contentEl.createEl("p", {
				cls: "copal-modal-danger",
				text: "Local files will be moved to Obsidian's trash.",
			});
		}

		const list = contentEl.createDiv({ cls: "copal-vault-list" });
		for (const v of this.vaults) {
			const row = list.createDiv({ cls: "copal-vault-row" });
			row.createSpan({ cls: "copal-vault-name", text: v.displayName });
			const b = row.createEl("button", { text: "Adopt" });
			b.onclick = () => {
				this.confirmAdopt(v, row, b);
			};
		}

		contentEl.createEl("p", {
			cls: "copal-modal-hint",
			text: "To sync remote files for the first time, create a new local vault, then adopt the remote one.",
		});
	}

	/** Replacing is destructive, so the row confirms IN PLACE. See the note above on nested modals. */
	private confirmAdopt(v: Vault, row: HTMLElement, button: HTMLButtonElement): void {
		if (this.localFileCount === 0) {
			this.pick({ kind: "adopt", vault: v });
			return;
		}
		if (row.hasClass("is-confirming")) return;
		row.addClass("is-confirming");
		button.remove();

		const n = this.localFileCount;
		row.createSpan({
			cls: "copal-vault-warning",
			text: `${n} local file${n === 1 ? "" : "s"} to Obsidian's trash.`,
		});
		const yes = row.createEl("button", { text: "Adopt", cls: "mod-warning" });
		yes.onclick = () => {
			this.pick({ kind: "adopt", vault: v });
		};
		const no = row.createEl("button", { text: "Cancel" });
		no.onclick = () => {
			row.empty();
			row.removeClass("is-confirming");
			row.createSpan({ cls: "copal-vault-name", text: v.displayName });
			const again = row.createEl("button", { text: "Adopt" });
			again.onclick = () => {
				this.confirmAdopt(v, row, again);
			};
		};
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolve?.(this.chosen);
		this.resolve = undefined;
	}

	private pick(choice: VaultChoice): void {
		this.chosen = choice;
		this.close();
	}
}
