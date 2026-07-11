// Minimal stub of the `obsidian` module so vitest can import the plugin's module graph. The pure
// connect/*, sync/*, and crdt/* modules never import obsidian; only main.ts/settings.ts (live-tested) and
// the small ui/* modules do. This provides just enough of the Modal/Setting/ButtonComponent surface for
// the ui/confirm unit test to run onOpen() and drive the confirm/cancel resolve logic.

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
export class Notice {
  constructor(_message: string) {}
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
