import { type App, Modal, Platform } from "obsidian";

/**
 * Open an external URL cross-platform.
 *
 * On **desktop** (Electron) `window.open` works. On **mobile** it does NOT: the OAuth authorize URL is
 * built only after several `await`s (discovery / client registration / PKCE), so by the time we'd call
 * `window.open` the user-gesture from the "Log in" tap is gone, and iOS/Android WebViews silently block a
 * non-gesture `window.open` (the bug: the "opening…" notice shows but nothing opens). Instead we present a
 * one-tap prompt with a real `<a href>` — the user's tap IS a gesture, and Obsidian's built-in mobile link
 * handler opens it in the system browser (the same path as tapping a link in a note).
 */
export function openExternal(app: App, url: string): void {
	if (Platform.isDesktop) {
		window.open(url, "_blank");
		return;
	}
	new ExternalLinkModal(app, url).open();
}

class ExternalLinkModal extends Modal {
	constructor(
		app: App,
		private readonly url: string,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Finish signing in" });
		contentEl.createEl("p", {
			text: "Open the Copal sign-in page in your browser, then return to Obsidian — you'll be connected automatically.",
		});
		const link = contentEl.createEl("a", {
			text: "Open sign-in page  →",
			href: this.url,
			cls: "copal-continue-btn",
		});
		link.setAttribute("target", "_blank");
		link.setAttribute("rel", "noopener");
		// Let Obsidian's link handler open the URL (this tap is a real user gesture), then dismiss the prompt.
		link.addEventListener("click", () => window.setTimeout(() => this.close(), 0));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
