// Minimal stub of the `obsidian` module so vitest can import the plugin's module graph. The pure
// connect/*, sync/*, and crdt/* modules never import obsidian; main.ts, settings.ts and the small ui/*
// modules do. It provides enough of the Modal/Setting/ButtonComponent surface for the ui/confirm unit
// test to drive onOpen(), and enough of the rest for `main-signout.test.ts` to IMPORT main.ts and call
// its sign-out paths.
//
// ⚠️ This file used to say main.ts was "live-tested" and stop there, which is the reason two security
// findings survived a green suite: the ordering that mattered lived in the one file nothing could load.
//
// It is still a stub, not an emulator. What it now additionally supports is ONE thing: running
// `onload()` to completion, so `main-onload.test.ts` can prove that `main.ts` routes its persistence
// through the single `PluginDataStore` rather than merely that `wirePersistence` would if it were
// called. Registrations are recorded, not honoured — `onLayoutReady` stores its callback instead of
// firing it, and nothing here renders, lays out, or dispatches. A test that needs real Obsidian
// behaviour still does not have it; that is roadmap row G11.

/** A tiny stand-in for Obsidian's augmented HTMLElement (createEl/setText/empty). */
class FakeEl {
	children: FakeEl[] = [];
	text = "";
	readonly classes = new Set<string>();
	addClass(...c: string[]): this {
		for (const x of c) this.classes.add(x);
		return this;
	}
	removeClass(...c: string[]): this {
		for (const x of c) this.classes.delete(x);
		return this;
	}
	createSvg(_tag: string, _o?: { attr?: Record<string, string> }): FakeEl {
		const el = new FakeEl();
		this.children.push(el);
		return el;
	}
	createEl(_tag: string, o?: { text?: string; cls?: string }): FakeEl {
		const el = new FakeEl();
		if (o?.text) el.text = o.text;
		this.children.push(el);
		return el;
	}
	createDiv(o?: { text?: string; cls?: string }): FakeEl {
		return this.createEl("div", o);
	}
	createSpan(o?: { text?: string; cls?: string }): FakeEl {
		return this.createEl("span", o);
	}
	setText(t: string): this {
		this.text = t;
		return this;
	}
	empty(): void {
		this.children = [];
	}
}

/** What `registerEvent` is handed. Opaque to the plugin; here it just records the subscription. */
export interface EventRef {
	name: string;
}

class FakeEvents {
	readonly handlers: { name: string; cb: (...a: never[]) => unknown }[] = [];
	on(name: string, cb: (...a: never[]) => unknown): EventRef {
		this.handlers.push({ name, cb });
		return { name };
	}
	/** Drive a registered handler from a test, with the argument shape Obsidian would pass. */
	emit(name: string, ...args: unknown[]): void {
		for (const h of this.handlers) {
			if (h.name === name) (h.cb as (...a: unknown[]) => unknown)(...args);
		}
	}
}

export class App {
	readonly vault = new FakeEvents();
	readonly workspace = Object.assign(new FakeEvents(), {
		/** Recorded, NOT fired: running it would start the reconcile that iterates a real vault. */
		layoutReadyCb: undefined as (() => void) | undefined,
		onLayoutReady(cb: () => void) {
			this.layoutReadyCb = cb;
		},
		getActiveViewOfType: (): unknown => null,
		openLinkText: (): void => {},
	});
}

/**
 * Enough `Plugin` for `onload()` to run. `loadData`/`saveData` are a real in-memory `data.json`, which
 * is the point: they are what proves `main.ts` hands ITS OWN pair to the single writer.
 */
export class Plugin {
	private stored: unknown = null;
	readonly commands: { id: string; name: string }[] = [];
	readonly views: string[] = [];
	readonly protocolHandlers = new Map<string, (p: Record<string, string>) => unknown>();
	readonly settingTabs: unknown[] = [];
	readonly eventRefs: EventRef[] = [];
	readonly domEvents: { type: string }[] = [];
	readonly editorExtensions: unknown[] = [];
	readonly ribbonIcons: { icon: string; title: string }[] = [];

	constructor(
		readonly app: App,
		readonly manifest: unknown,
	) {}

	loadData(): Promise<unknown> {
		return Promise.resolve(this.stored);
	}
	saveData(data: unknown): Promise<void> {
		// Serialised, as Obsidian does: the bytes are frozen at write time, so a later mutation of the
		// caller's object cannot retroactively change what an earlier write is recorded as having saved.
		this.stored = JSON.parse(JSON.stringify(data));
		return Promise.resolve();
	}
	registerEvent(ref: EventRef): void {
		this.eventRefs.push(ref);
	}
	registerDomEvent(_el: unknown, type: string, _cb: unknown): void {
		this.domEvents.push({ type });
	}
	registerEditorExtension(ext: unknown): void {
		this.editorExtensions.push(ext);
	}
	registerObsidianProtocolHandler(name: string, cb: (p: Record<string, string>) => unknown): void {
		this.protocolHandlers.set(name, cb);
	}
	registerView(type: string, _factory: unknown): void {
		this.views.push(type);
	}
	addCommand(cmd: { id: string; name: string }): void {
		this.commands.push(cmd);
	}
	addStatusBarItem(): FakeEl {
		return new FakeEl();
	}
	addRibbonIcon(icon: string, title: string, _cb: unknown): FakeEl {
		this.ribbonIcons.push({ icon, title });
		return new FakeEl();
	}
	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}
}
export class PluginSettingTab {
	/** Real `PluginSettingTab` has one and `display()`/`refresh()` empty it, so the stub must too. */
	containerEl = new FakeEl();
	constructor(
		public app?: unknown,
		public plugin?: unknown,
	) {}
}
export class ItemView {
	constructor(readonly leaf?: unknown) {}
}
export class MarkdownView {}
export class Menu {
	addItem(): this {
		return this;
	}
	showAtMouseEvent(): void {}
}
export interface WorkspaceLeaf {
	view?: unknown;
}
export type TAbstractFile = { path: string };
export type TFile = { path: string; extension: string };
export const Platform = { isMobile: false };
export function setIcon(_el: unknown, _icon: string): void {}
export function setTooltip(_el: unknown, _text: string, _opts?: unknown): void {}
/** Obsidian collapses duplicate separators and strips a leading one; paths here are already safe. */
export function normalizePath(p: string): string {
	return p.replace(/\/{2,}/g, "/").replace(/^\//, "");
}
export class Notice {
	constructor(_message: string) {}
}

// A swappable `requestUrl` (Obsidian's CORS-free native request) so the fetch-adapter unit test can drive
// controlled responses. `__setRequestUrl` replaces the implementation the exported `requestUrl` delegates to.
export interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}
export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text: string;
	json: unknown;
}
let requestUrlImpl: (p: RequestUrlParam) => Promise<RequestUrlResponse> = () =>
	Promise.reject(new Error("requestUrl not stubbed in this test"));
export function __setRequestUrl(fn: (p: RequestUrlParam) => Promise<RequestUrlResponse>): void {
	requestUrlImpl = fn;
}
export function requestUrl(p: RequestUrlParam): Promise<RequestUrlResponse> {
	return requestUrlImpl(p);
}

export class ButtonComponent {
	onClickCb: (() => void) | undefined;
	setButtonText(_t: string): this {
		return this;
	}
	setCta(): this {
		return this;
	}
	setWarning(): this {
		return this;
	}
	setIcon(_i: string): this {
		return this;
	}
	onClick(cb: () => void): this {
		this.onClickCb = cb;
		return this;
	}
}

export class Setting {
	constructor(_containerEl?: unknown) {}
	setName(_n: string): this {
		return this;
	}
	setDesc(_d: string): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	addButton(cb: (b: ButtonComponent) => void): this {
		cb(new ButtonComponent());
		return this;
	}
}

export class Modal {
	contentEl = new FakeEl();
	titleEl = new FakeEl();
	constructor(public app: unknown) {}
	setTitle(t: string): this {
		this.titleEl.setText(t);
		return this;
	}
	open(): void {
		this.onOpen();
	}
	close(): void {
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}
