import { ItemView, type WorkspaceLeaf, setIcon } from "obsidian";
import type { SearchHit, SearchMode } from "../sync/api";

export const COPAL_SEARCH_VIEW = "copal-search";

/** What the pane needs from the plugin — kept narrow so the view is easy to reason about (and stub in tests). */
export interface SearchHost {
	/** Search the connected vault. Rejects with a connection error when the vault isn't linked yet. */
	searchVault(query: string, mode: SearchMode): Promise<SearchHit[]>;
	/** Whether a Copal vault is currently linked (drives the not-connected empty state). */
	isConnected(): Promise<boolean>;
	/** Open a note by its vault-relative path (click-through from a result). */
	openNote(path: string): void;
}

const DEBOUNCE_MS = 250;

/**
 * The in-Obsidian "search my vault by meaning" pane (a right-sidebar `ItemView`). Humans get the same
 * server-side vector index the agent uses over MCP — Obsidian's built-in search is local + exact only.
 * Defaults to **by-meaning** (semantic) search, with a toggle to **exact** (keyword, Obsidian-parity);
 * results are server-ranked (no score is exposed) and clicking one opens the note. Works only when a vault
 * is linked; otherwise it prompts to connect. The ribbon icon is the mobile-visible entry point.
 */
export class CopalSearchView extends ItemView {
	private mode: SearchMode = "semantic";
	private query = "";
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private seq = 0; // guards against a slow earlier search overwriting a newer one
	private inputEl!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private modeButtons: Partial<Record<SearchMode, HTMLElement>> = {};

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: SearchHost,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return COPAL_SEARCH_VIEW;
	}
	override getDisplayText(): string {
		return "Copal search";
	}
	override getIcon(): string {
		return "search";
	}

	override async onOpen(): Promise<void> {
		// Fill the view content via an absolutely-positioned child rather than height:100% — a percentage
		// height is unreliable when the parent's height comes from flex (Obsidian's mobile `.view-content`),
		// which left dead space + clipped the results when the on-screen keyboard resized the pane.
		const host = this.containerEl.children[1] as HTMLElement;
		host.empty();
		host.addClass("copal-search-host");
		const root = host.createDiv({ cls: "copal-search" });

		const header = root.createDiv({ cls: "copal-search-header" });
		this.inputEl = header.createEl("input", {
			cls: "copal-search-input",
			attr: {
				type: "search",
				placeholder: "Search your vault by meaning…",
				enterkeyhint: "search",
				// Stop the mobile keyboard from mangling the query (auto-capitalizing "food" → "Food", autocorrect).
				autocapitalize: "none",
				autocorrect: "off",
				spellcheck: "false",
			},
		});

		const modes = header.createDiv({ cls: "copal-search-modes" });
		this.addModeButton(modes, "semantic", "By meaning");
		this.addModeButton(modes, "keyword", "Exact");

		this.resultsEl = root.createDiv({ cls: "copal-search-results" });
		// On mobile, dismiss the on-screen keyboard when the user starts scrolling the results — it frees the
		// space and is the expected gesture (tapping a result dismisses it too, see renderResults).
		this.resultsEl.addEventListener("touchmove", () => this.inputEl.blur(), { passive: true });

		this.inputEl.addEventListener("input", () => {
			this.query = this.inputEl.value;
			this.scheduleSearch();
		});
		// Enter searches immediately (skip the debounce).
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.query = this.inputEl.value;
				void this.runSearch();
			}
		});

		this.renderPrompt("Search your vault by meaning.");
		// Defer focus so Obsidian has attached the leaf.
		window.setTimeout(() => this.inputEl.focus(), 0);
	}

	override async onClose(): Promise<void> {
		if (this.debounce !== undefined) clearTimeout(this.debounce);
	}

	private addModeButton(parent: HTMLElement, mode: SearchMode, label: string): void {
		const btn = parent.createEl("button", { cls: "copal-search-mode", text: label });
		if (mode === this.mode) btn.addClass("is-active");
		btn.addEventListener("click", () => {
			if (this.mode === mode) return;
			this.mode = mode;
			for (const [m, el] of Object.entries(this.modeButtons))
				el?.toggleClass("is-active", m === mode);
			this.inputEl.setAttribute(
				"placeholder",
				mode === "semantic" ? "Search your vault by meaning…" : "Search your vault (exact)…",
			);
			if (this.query.trim().length > 0) void this.runSearch();
		});
		this.modeButtons[mode] = btn;
	}

	private scheduleSearch(): void {
		if (this.debounce !== undefined) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.runSearch(), DEBOUNCE_MS);
	}

	private async runSearch(): Promise<void> {
		const query = this.query.trim();
		if (query.length === 0) {
			this.renderPrompt("Search your vault by meaning.");
			return;
		}
		const mine = ++this.seq;
		this.renderMessage("Searching…", "copal-search-loading");
		try {
			const hits = await this.host.searchVault(query, this.mode);
			if (mine !== this.seq) return; // a newer search superseded this one
			this.renderResults(hits);
		} catch (err) {
			if (mine !== this.seq) return;
			const connected = await this.host.isConnected();
			this.renderPrompt(
				connected
					? `Search failed: ${err instanceof Error ? err.message : String(err)}`
					: "Connect Copal to search your vault. Open Settings → Copal to link a vault.",
			);
		}
	}

	private renderResults(hits: readonly SearchHit[]): void {
		this.resultsEl.empty();
		if (hits.length === 0) {
			this.renderPrompt("No matches.");
			return;
		}
		for (const hit of hits) {
			const item = this.resultsEl.createDiv({ cls: "copal-search-hit" });
			item.setAttribute("role", "button");
			item.tabIndex = 0;
			const title = item.createDiv({ cls: "copal-search-hit-title" });
			setIcon(title.createSpan({ cls: "copal-search-hit-icon" }), "file-text");
			title.createSpan({ text: hit.title || hit.path });
			item.createDiv({ cls: "copal-search-hit-path", text: hit.path });
			if (hit.snippet.length > 0) {
				item.createDiv({ cls: "copal-search-hit-snippet", text: hit.snippet });
			}
			const open = (): void => {
				this.inputEl.blur(); // dismiss the mobile keyboard before switching to the note
				this.host.openNote(hit.path);
			};
			item.addEventListener("click", open);
			item.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			});
		}
	}

	private renderPrompt(text: string): void {
		this.renderMessage(text, "copal-search-empty");
	}

	private renderMessage(text: string, cls: string): void {
		this.resultsEl.empty();
		this.resultsEl.createDiv({ cls, text });
	}
}
