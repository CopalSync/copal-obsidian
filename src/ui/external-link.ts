import { type App, Modal, Platform } from "obsidian";
import { asTrustedUrl, type TrustedUrl } from "../sync/safe-url";

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
export function openExternal(app: App, url: TrustedUrl): void {
	// Belt and braces. The type already says this URL was checked, but this function is the one place in
	// the plugin where a bad URL is EXECUTED rather than merely fetched — `javascript:` reaches both the
	// `window.open` below and the real `<a href>` the mobile branch renders. A runtime check costs
	// nothing and does not depend on every future caller being in TypeScript's reach.
	const checked = asTrustedUrl(url);
	if (Platform.isDesktop) {
		window.open(checked, "_blank");
		return;
	}
	new ExternalLinkModal(app, checked).open();
}

class ExternalLinkModal extends Modal {
	constructor(
		app: App,
		private readonly url: TrustedUrl,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Finish signing in");
		contentEl.createEl("p", {
			text: "Open the Copal sign-in page in your browser, then return to Obsidian. You will be connected automatically.",
		});
		const link = contentEl.createEl("a", {
			text: "Open sign-in page  →",
			href: this.url,
			cls: "copal-continue-btn",
		});
		link.setAttribute("target", "_blank");
		link.setAttribute("rel", "noopener");
		// Let Obsidian's link handler open the URL (this tap is a real user gesture), then dismiss the prompt.
		// `addEventListener`, not `registerDomEvent`: `Modal` is not a `Component` and has no such method.
		// `onClose` empties `contentEl`, so the listener goes with the element it is on.
		link.addEventListener("click", () => window.setTimeout(() => this.close(), 0));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
