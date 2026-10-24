// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type SearchHit, type SearchMode } from "../../src/sync/api";
import { COPAL_SEARCH_VIEW, CopalSearchView, type SearchHost } from "../../src/ui/search-view";

/**
 * `src/ui/search-view.ts` had zero test references — 244 lines, the mobile-visible entry point to the
 * product's differentiating feature. The old double could not construct it at all: its `ItemView` had no
 * `containerEl`, and this view reads `containerEl.children[1]` and calls `registerDomEvent` six times.
 *
 * Everything here goes through real DOM and real events, because the properties worth having are about
 * what the user sees and what a keystroke does — neither of which a recorded call can show.
 */
function hit(path: string, over: Partial<SearchHit> = {}): SearchHit {
	return { path, title: path.replace(/\.md$/, ""), snippet: "a snippet", ...over } as SearchHit;
}

interface Harness {
	view: CopalSearchView;
	host: SearchHost & { queries: { query: string; mode: SearchMode }[]; opened: string[] };
	input: HTMLInputElement;
	results: HTMLElement;
	text(): string;
}

async function open(
	over: {
		connected?: boolean;
		vault?: boolean;
		search?: (q: string, m: SearchMode) => Promise<SearchHit[]>;
	} = {},
): Promise<Harness> {
	const queries: { query: string; mode: SearchMode }[] = [];
	const opened: string[] = [];
	const host = {
		queries,
		opened,
		isConnected: () => over.connected ?? true,
		hasVault: () => over.vault ?? true,
		openNote: (p: string) => void opened.push(p),
		searchVault: async (query: string, mode: SearchMode) => {
			queries.push({ query, mode });
			return over.search === undefined ? [hit("a.md")] : await over.search(query, mode);
		},
	};
	const view = new CopalSearchView({} as never, host as unknown as SearchHost);
	await view.onOpen();
	const root = view.containerEl;
	return {
		view,
		host,
		input: root.querySelector("input") as HTMLInputElement,
		results: root.querySelector(".copal-search-results") as HTMLElement,
		text: () => root.textContent ?? "",
	};
}

/** Type into the real input and dispatch the real event the view listens for. */
function type(h: Harness, value: string): void {
	h.input.value = value;
	h.input.dispatchEvent(new Event("input"));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.body.empty();
});

describe("the view's identity", () => {
	it("reports the type the ribbon and command look it up by", async () => {
		const h = await open();
		expect(h.view.getViewType()).toBe(COPAL_SEARCH_VIEW);
		expect(h.view.getDisplayText()).toBe("Copal search");
		expect(h.view.getIcon()).toBe("search");
	});
});

describe("the idle state tells the user which of THREE things is wrong", () => {
	it("not signed in → points at Settings to sign in", async () => {
		const h = await open({ connected: false });
		expect(h.text()).toMatch(/Not signed in/);
	});

	it("signed in without a vault → points at Sync, which is a DIFFERENT fix", async () => {
		// ⛔ Collapsing these two into one message sends half the people to the wrong button.
		const h = await open({ connected: true, vault: false });
		expect(h.text()).toMatch(/No vault yet/);
		expect(h.text()).not.toMatch(/Not signed in/);
	});

	it("ready → invites a search", async () => {
		const h = await open();
		expect(h.text()).toMatch(/Search your vault by meaning/);
	});
});

describe("it refuses BEFORE searching, not after a round trip fails", () => {
	it("never calls searchVault when not signed in", async () => {
		// ⚠️ The message used to live only in the catch, so somebody signed out typed a query, watched
		// "Searching…", waited for a round trip that could not work, and was told afterwards.
		const h = await open({ connected: false });
		type(h, "anything");
		await vi.advanceTimersByTimeAsync(300);
		expect(h.host.queries, "the pane knows this before the first keystroke").toEqual([]);
		expect(h.text()).toMatch(/Not signed in/);
		expect(h.text()).not.toMatch(/Searching…/);
	});

	it("never calls searchVault when there is no vault", async () => {
		const h = await open({ vault: false });
		type(h, "anything");
		await vi.advanceTimersByTimeAsync(300);
		expect(h.host.queries).toEqual([]);
	});
});

describe("typing", () => {
	it("debounces, so a burst of keystrokes is one search", async () => {
		const h = await open();
		type(h, "a");
		type(h, "ab");
		type(h, "abc");
		expect(h.host.queries, "nothing before the debounce elapses").toEqual([]);
		await vi.advanceTimersByTimeAsync(300);
		expect(h.host.queries.map((q) => q.query)).toEqual(["abc"]);
	});

	it("Enter searches immediately, skipping the debounce", async () => {
		const h = await open();
		h.input.value = "now";
		h.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(h.host.queries.map((q) => q.query)).toEqual(["now"]);
	});

	it("clearing the query returns to the idle prompt rather than searching for nothing", async () => {
		const h = await open();
		type(h, "x");
		await vi.advanceTimersByTimeAsync(300);
		type(h, "   ");
		await vi.advanceTimersByTimeAsync(300);
		expect(h.host.queries.map((q) => q.query)).toEqual(["x"]);
		expect(h.text()).toMatch(/Search your vault by meaning/);
	});
});

describe("a slow earlier search cannot overwrite a newer one", () => {
	it("discards the stale response", async () => {
		// Without the sequence guard the user sees results for a query they have already replaced —
		// which looks exactly like the search being wrong.
		const releases: ((hits: SearchHit[]) => void)[] = [];
		const h = await open({
			search: (q) =>
				new Promise<SearchHit[]>((resolve) => {
					releases.push(resolve);
					void q;
				}),
		});
		type(h, "first");
		await vi.advanceTimersByTimeAsync(300);
		type(h, "second");
		await vi.advanceTimersByTimeAsync(300);
		expect(releases.length).toBe(2);

		// The FIRST search answers last.
		releases[1]?.([hit("second-result.md")]);
		await vi.advanceTimersByTimeAsync(0);
		releases[0]?.([hit("stale-result.md")]);
		await vi.advanceTimersByTimeAsync(0);

		expect(h.text()).toMatch(/second-result/);
		expect(h.text(), "the superseded response must be dropped").not.toMatch(/stale-result/);
	});
});

describe("results", () => {
	it("renders title, path and snippet for each hit", async () => {
		const h = await open({
			search: async () => [hit("notes/deep/Thing.md", { title: "Thing", snippet: "about things" })],
		});
		type(h, "thing");
		await vi.advanceTimersByTimeAsync(300);
		expect(h.results.querySelectorAll(".copal-search-hit").length).toBe(1);
		expect(h.results.querySelector(".copal-search-hit-path")?.textContent).toBe(
			"notes/deep/Thing.md",
		);
		expect(h.results.querySelector(".copal-search-hit-snippet")?.textContent).toBe("about things");
		expect(h.text()).toMatch(/Thing/);
	});

	it("falls back to the path when a hit has no title", async () => {
		const h = await open({ search: async () => [hit("untitled.md", { title: "" })] });
		type(h, "x");
		await vi.advanceTimersByTimeAsync(300);
		expect(h.text()).toMatch(/untitled\.md/);
	});

	it("says so when there are no matches", async () => {
		const h = await open({ search: async () => [] });
		type(h, "nothing");
		await vi.advanceTimersByTimeAsync(300);
		expect(h.text()).toMatch(/No matches/);
	});

	it("opens the note when a result is clicked, via ONE delegated listener", async () => {
		// The path travels on the element, not in a closure, because results re-render on every
		// keystroke — a listener per hit per render leaks in proportion to how much the user types.
		const h = await open({ search: async () => [hit("open/me.md")] });
		type(h, "me");
		await vi.advanceTimersByTimeAsync(300);
		const inner = h.results.querySelector(".copal-search-hit-snippet") as HTMLElement;
		inner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(h.host.opened, "a click anywhere inside the hit opens it").toEqual(["open/me.md"]);
	});

	it("opens a result from the keyboard, so the pane is not mouse-only", async () => {
		const h = await open({ search: async () => [hit("kbd.md")] });
		type(h, "k");
		await vi.advanceTimersByTimeAsync(300);
		const item = h.results.querySelector(".copal-search-hit") as HTMLElement;
		expect(item.getAttribute("role")).toBe("button");
		expect(item.tabIndex).toBe(0);
		item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(h.host.opened).toEqual(["kbd.md"]);
	});

	it("a click outside any hit opens nothing", async () => {
		const h = await open({ search: async () => [hit("a.md")] });
		type(h, "a");
		await vi.advanceTimersByTimeAsync(300);
		h.results.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(h.host.opened).toEqual([]);
	});
});

describe("the mode toggle", () => {
	it("defaults to by-meaning, which is the point of the feature", async () => {
		const h = await open();
		type(h, "q");
		await vi.advanceTimersByTimeAsync(300);
		expect(h.host.queries[0]?.mode).toBe("semantic");
	});

	it("switches to exact and re-runs the current query", async () => {
		const h = await open();
		type(h, "q");
		await vi.advanceTimersByTimeAsync(300);
		const exact = [...h.view.containerEl.querySelectorAll("button")].find(
			(b) => b.textContent === "Exact",
		) as HTMLElement;
		exact.click();
		await vi.advanceTimersByTimeAsync(300);
		expect(h.host.queries.map((q) => q.mode)).toEqual(["semantic", "keyword"]);
		expect(h.input.getAttribute("placeholder")).toMatch(/exact/i);
		expect(exact.classList.contains("is-active")).toBe(true);
	});

	it("re-selecting the active mode does not re-search", async () => {
		const h = await open();
		type(h, "q");
		await vi.advanceTimersByTimeAsync(300);
		const byMeaning = [...h.view.containerEl.querySelectorAll("button")].find(
			(b) => b.textContent === "By meaning",
		) as HTMLElement;
		byMeaning.click();
		await vi.advanceTimersByTimeAsync(300);
		expect(h.host.queries.length).toBe(1);
	});
});

describe("failures", () => {
	it("a stale session gets an actionable message, not a generic one", async () => {
		const h = await open({
			search: () => Promise.reject(new ApiError(401, "unauthorized")),
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		type(h, "q");
		await vi.advanceTimersByTimeAsync(300);
		expect(h.text()).toMatch(/sign-in is no longer valid/i);
	});

	it("any other failure stays generic, with the detail going to the console", async () => {
		// A raw server message helps nobody, and the detail still has to go somewhere.
		const h = await open({ search: () => Promise.reject(new Error("ECONNRESET at line 9")) });
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		type(h, "q");
		await vi.advanceTimersByTimeAsync(300);
		expect(h.text()).toMatch(/unavailable right now/i);
		expect(h.text()).not.toMatch(/ECONNRESET/);
		expect(logged).toHaveBeenCalled();
	});
});

describe("teardown", () => {
	it("clears the pending debounce and focus timers, so nothing fires into a detached view", async () => {
		// G5: an unowned focus timer fires into a view that is gone.
		const h = await open();
		type(h, "pending");
		await h.view.onClose();
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.host.queries, "a debounced search must not outlive the pane").toEqual([]);
	});
});
