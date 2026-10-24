/**
 * Obsidian's DOM helpers, installed onto the real `Element`/`Node` prototypes.
 *
 * Obsidian augments the DOM globally — `obsidian.d.ts` declares `createEl`, `createDiv`, `addClass`,
 * `empty`, `detach` and the rest on `Node`/`Element`/`HTMLElement` inside a `declare global` block. So
 * the plugin's UI code calls them on ordinary elements, and the TYPES for them come from the real
 * package whether or not anything installs them at runtime.
 *
 * ⚠️ That asymmetry is the trap. A helper that typechecks perfectly can still do nothing: the stub this
 * replaced accepted `cls` in `createEl` and silently discarded it, ignored `createSvg` attributes
 * entirely, and had no `detach`/`setAttr`/`toggleClass` at all — and every call site still compiled.
 * `test/stubs/obsidian-dom.test.ts` therefore asserts the EFFECT of each helper on real DOM state, not
 * that it exists. Types prove the signature; only a round trip proves the behaviour.
 *
 * Install is idempotent and must be called before any UI code runs; `test/setup.ts` does it for every
 * file that has a DOM. Under the default `node` environment there is no `Element`, so nothing happens.
 */

const INSTALLED = Symbol.for("copal.obsidian-dom.installed");

type CreateEl = (
	tag: string,
	o?: DomElementInfo | string,
	callback?: (created: HTMLElement) => void,
) => HTMLElement;
type CreateTagless = (
	o?: DomElementInfo | string,
	callback?: (created: HTMLElement) => void,
) => HTMLElement;

/** `createEl`/`createDiv`/`createSpan` take either a `DomElementInfo` or a bare string meaning `cls`. */
function normalizeInfo(o?: DomElementInfo | string): DomElementInfo {
	return typeof o === "string" ? { cls: o } : (o ?? {});
}

function applyClasses(el: Element, cls: string | string[] | undefined): void {
	if (cls === undefined) return;
	const list = Array.isArray(cls) ? cls : cls.split(/\s+/);
	for (const c of list) if (c !== "") el.classList.add(c);
}

function applyAttrs(el: Element, attr: Record<string, string | number | boolean | null>): void {
	for (const [k, v] of Object.entries(attr)) {
		// Obsidian removes an attribute set to null/false rather than writing the literal.
		if (v === null || v === false) el.removeAttribute(k);
		else el.setAttribute(k, v === true ? "" : String(v));
	}
}

function place(parent: Node, el: Node, prepend: boolean | undefined): void {
	if (prepend === true && parent.firstChild !== null) parent.insertBefore(el, parent.firstChild);
	else parent.appendChild(el);
}

/** Install Obsidian's documented DOM helpers. Idempotent; a no-op without a DOM. */
export function installObsidianDom(): void {
	if (typeof Element === "undefined") return;
	const g = globalThis as unknown as Record<symbol, boolean>;
	if (g[INSTALLED] === true) return;
	g[INSTALLED] = true;

	const node = Node.prototype as unknown as Record<string, unknown>;
	const el = Element.prototype as unknown as Record<string, unknown>;

	// ── Node ────────────────────────────────────────────────────────────────────────────────────
	node.detach = function (this: Node): void {
		this.parentNode?.removeChild(this);
	};
	node.empty = function (this: Node): void {
		while (this.firstChild !== null) this.removeChild(this.firstChild);
	};
	node.appendText = function (this: Node, val: string): void {
		this.appendChild(document.createTextNode(val));
	};
	node.getText = function (this: Node): string {
		return this.textContent ?? "";
	};
	node.setText = function (this: Node, val: string | DocumentFragment): void {
		if (typeof val === "string") this.textContent = val;
		else {
			(this as unknown as { empty(): void }).empty();
			this.appendChild(val);
		}
	};
	node.insertAfter = function <T extends Node>(this: Node, other: T, child?: Node | null): T {
		this.insertBefore(other, child?.nextSibling ?? null);
		return other;
	};

	// ── Element: classes and attributes ─────────────────────────────────────────────────────────
	el.addClass = function (this: Element, ...classes: string[]): void {
		applyClasses(this, classes);
	};
	el.addClasses = function (this: Element, classes: string[]): void {
		applyClasses(this, classes);
	};
	el.removeClass = function (this: Element, ...classes: string[]): void {
		for (const c of classes) this.classList.remove(c);
	};
	el.removeClasses = function (this: Element, classes: string[]): void {
		for (const c of classes) this.classList.remove(c);
	};
	el.toggleClass = function (this: Element, classes: string | string[], value: boolean): void {
		for (const c of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(c, value);
	};
	el.hasClass = function (this: Element, cls: string): boolean {
		return this.classList.contains(cls);
	};
	el.setAttr = function (
		this: Element,
		qualifiedName: string,
		value: string | number | boolean | null,
	): void {
		applyAttrs(this, { [qualifiedName]: value });
	};
	el.setAttrs = function (
		this: Element,
		obj: Record<string, string | number | boolean | null>,
	): void {
		applyAttrs(this, obj);
	};

	// ── Element: queries ────────────────────────────────────────────────────────────────────────
	el.find = function (this: Element, selector: string): Element | null {
		return this.querySelector(selector);
	};
	el.findAll = function (this: Element, selector: string): HTMLElement[] {
		return [...this.querySelectorAll(selector)] as HTMLElement[];
	};
	el.findAllSelf = function (this: Element, selector: string): HTMLElement[] {
		const all = [...this.querySelectorAll(selector)] as HTMLElement[];
		return this.matches(selector) ? [this as HTMLElement, ...all] : all;
	};

	// ── Element: creation ───────────────────────────────────────────────────────────────────────
	el.createEl = function (
		this: Element,
		tag: string,
		o?: DomElementInfo | string,
		callback?: (created: HTMLElement) => void,
	): HTMLElement {
		const info = normalizeInfo(o);
		const created = document.createElement(tag);
		applyClasses(created, info.cls);
		if (info.text !== undefined)
			(created as unknown as { setText(v: unknown): void }).setText(info.text);
		if (info.attr !== undefined) applyAttrs(created, info.attr);
		if (info.title !== undefined) created.title = info.title;
		if (info.href !== undefined) created.setAttribute("href", info.href);
		if (info.value !== undefined) (created as HTMLInputElement).value = info.value;
		if (info.type !== undefined) created.setAttribute("type", info.type);
		if (info.placeholder !== undefined) created.setAttribute("placeholder", info.placeholder);
		place(info.parent ?? this, created, info.prepend);
		callback?.(created);
		return created;
	};
	el.createDiv = function (
		this: Element,
		o?: DomElementInfo | string,
		callback?: (created: HTMLElement) => void,
	): HTMLElement {
		return (this as unknown as { createEl: CreateEl }).createEl("div", o, callback);
	};
	el.createSpan = function (
		this: Element,
		o?: DomElementInfo | string,
		callback?: (created: HTMLElement) => void,
	): HTMLElement {
		return (this as unknown as { createEl: CreateEl }).createEl("span", o, callback);
	};
	el.createSvg = function (
		this: Element,
		tag: string,
		o?: SvgElementInfo | string,
		callback?: (created: SVGElement) => void,
	): SVGElement {
		const info = typeof o === "string" ? ({ cls: o } as SvgElementInfo) : (o ?? {});
		const created = document.createElementNS("http://www.w3.org/2000/svg", tag);
		applyClasses(created, info.cls);
		if (info.attr !== undefined) applyAttrs(created, info.attr);
		place(info.parent ?? this, created, info.prepend);
		callback?.(created);
		return created;
	};
	el.onClickEvent = function (
		this: Element,
		listener: (ev: MouseEvent) => unknown,
		options?: boolean | AddEventListenerOptions,
	): void {
		this.addEventListener("click", listener as EventListener, options);
	};

	// `document.createEl` / `createDiv` etc. hang off Document too.
	const doc = Document.prototype as unknown as Record<string, unknown>;
	doc.createEl = function (
		this: Document,
		tag: string,
		o?: DomElementInfo | string,
		callback?: (created: HTMLElement) => void,
	): HTMLElement {
		return (this.body as unknown as { createEl: CreateEl }).createEl(tag, o, callback);
	};
	doc.createDiv = function (
		this: Document,
		o?: DomElementInfo | string,
		callback?: (created: HTMLElement) => void,
	): HTMLElement {
		return (this.body as unknown as { createDiv: CreateTagless }).createDiv(o, callback);
	};
	doc.createSpan = function (
		this: Document,
		o?: DomElementInfo | string,
		callback?: (created: HTMLElement) => void,
	): HTMLElement {
		return (this.body as unknown as { createSpan: CreateTagless }).createSpan(o, callback);
	};
}
