// Minimal stub of the `obsidian` module so vitest can import the plugin's module graph. The pure
// connect/*, sync/*, and crdt/* modules never import obsidian; main.ts, settings.ts and the small ui/*
// modules do. It provides enough of the Modal/Setting/ButtonComponent surface for the ui/confirm unit
// test to drive onOpen(), and enough of the rest for `main-signout.test.ts` to IMPORT main.ts and call
// its sign-out paths.
//
// ⚠️ This file used to say main.ts was "live-tested" and stop there, which is the reason two security
// findings survived a green suite: the ordering that mattered lived in the one file nothing could load.
// Everything below that is not in the Modal/Setting surface exists so that file can be loaded. It is a
// stub, not an emulator — it makes main.ts importable and its plain methods callable, nothing more.

/** A tiny stand-in for Obsidian's augmented HTMLElement (createEl/setText/empty). */
class FakeEl {
	children: FakeEl[] = [];
	text = "";
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

export class Plugin {}
export class PluginSettingTab {}
export class App {}
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
