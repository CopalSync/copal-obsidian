// @vitest-environment jsdom
/**
 * The helpers are asserted by EFFECT, not existence.
 *
 * The stub this replaced had `createEl` accept `cls` and throw it away, and `createSvg` ignore its
 * attributes — both typechecked against the real `obsidian.d.ts` the whole time. A test that only
 * called them would have passed. So every case below reads real DOM state back.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { installObsidianDom } from "./obsidian-dom";

beforeAll(() => installObsidianDom());

const div = (): HTMLElement => document.createElement("div");

describe("createEl", () => {
	it("honours cls, text, attr, href, title and parents the result", () => {
		const root = div();
		const a = root.createEl("a", {
			cls: "copal-link primary",
			text: "Finish signing in",
			attr: { target: "_blank", rel: "noopener" },
			href: "https://copal.uk/plugin/connect",
			title: "tip",
		});
		expect(a.tagName).toBe("A");
		expect(a.classList.contains("copal-link")).toBe(true);
		expect(a.classList.contains("primary")).toBe(true);
		expect(a.textContent).toBe("Finish signing in");
		expect(a.getAttribute("target")).toBe("_blank");
		expect(a.getAttribute("rel")).toBe("noopener");
		expect(a.getAttribute("href")).toBe("https://copal.uk/plugin/connect");
		expect(a.title).toBe("tip");
		expect(a.parentElement).toBe(root);
	});

	it("takes an array of classes and a bare string meaning cls", () => {
		const root = div();
		expect(root.createEl("p", { cls: ["a", "b"] }).className).toBe("a b");
		expect(root.createEl("p", "solo").classList.contains("solo")).toBe(true);
	});

	it("prepends when asked, and honours an explicit parent", () => {
		const root = div();
		root.createEl("span", { text: "second" });
		root.createEl("span", { text: "first", prepend: true });
		expect([...root.children].map((c) => c.textContent)).toEqual(["first", "second"]);

		const other = div();
		const moved = root.createEl("b", { parent: other });
		expect(moved.parentElement).toBe(other);
	});

	it("runs the callback with the created element", () => {
		const root = div();
		let seen: HTMLElement | undefined;
		const made = root.createEl("i", undefined, (e) => {
			seen = e;
		});
		expect(seen).toBe(made);
	});

	it("createDiv and createSpan produce the right tags", () => {
		const root = div();
		expect(root.createDiv().tagName).toBe("DIV");
		expect(root.createSpan({ text: "x" }).tagName).toBe("SPAN");
	});
});

describe("createSvg", () => {
	it("creates in the SVG namespace and applies attributes", () => {
		const svg = div().createSvg("svg", { cls: "gem", attr: { viewBox: "0 0 24 24", width: 16 } });
		expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
		expect(svg.getAttribute("width")).toBe("16");
		expect(svg.classList.contains("gem")).toBe(true);
	});
});

describe("classes and attributes", () => {
	it("addClass / removeClass / toggleClass / hasClass", () => {
		const el = div();
		el.addClass("one", "two");
		expect(el.hasClass("one")).toBe(true);
		el.removeClass("one");
		expect(el.hasClass("one")).toBe(false);
		el.toggleClass("three", true);
		expect(el.hasClass("three")).toBe(true);
		el.toggleClass("three", false);
		expect(el.hasClass("three")).toBe(false);
		el.addClasses(["x", "y"]);
		el.removeClasses(["x"]);
		expect(el.className).toBe("two y");
	});

	it("setAttr removes rather than writes for null and false, as Obsidian does", () => {
		const el = div();
		el.setAttr("data-a", "1");
		expect(el.getAttribute("data-a")).toBe("1");
		el.setAttr("data-a", null);
		expect(el.hasAttribute("data-a")).toBe(false);
		el.setAttrs({ "data-b": 2, "data-c": true, "data-d": false });
		expect(el.getAttribute("data-b")).toBe("2");
		expect(el.getAttribute("data-c")).toBe("");
		expect(el.hasAttribute("data-d")).toBe(false);
	});
});

describe("text and tree", () => {
	it("setText / getText / appendText", () => {
		const el = div();
		el.setText("hello");
		expect(el.getText()).toBe("hello");
		el.appendText(" world");
		expect(el.textContent).toBe("hello world");
	});

	it("empty() removes children; detach() removes the node from its parent", () => {
		const root = div();
		const child = root.createDiv({ text: "gone" });
		expect(root.children.length).toBe(1);
		root.empty();
		expect(root.children.length).toBe(0);
		expect(child.parentElement, "empty() detaches what it removes").toBe(null);

		const keep = root.createDiv();
		expect(keep.parentElement).toBe(root);
		keep.detach();
		expect(keep.parentElement).toBe(null);
	});

	it("find / findAll query descendants", () => {
		const root = div();
		root.createDiv({ cls: "hit" });
		root.createDiv({ cls: "hit" });
		root.createDiv({ cls: "miss" });
		expect(root.find(".hit")?.className).toBe("hit");
		expect(root.findAll(".hit").length).toBe(2);
	});

	it("onClickEvent wires a real listener", () => {
		const el = div();
		let clicks = 0;
		el.onClickEvent(() => {
			clicks += 1;
		});
		el.dispatchEvent(new MouseEvent("click"));
		expect(clicks).toBe(1);
	});
});
