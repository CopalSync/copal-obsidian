import { type App, Modal, Setting } from "obsidian";

export interface ConfirmOptions {
	title: string;
	body: string;
	/** The confirm button's label (e.g. "Disconnect", "Adopt"). */
	cta: string;
	/** Style the confirm button as destructive (warning) rather than a primary CTA. */
	danger?: boolean;
}

/**
 * A cross-platform confirmation dialog. Replaces `window.confirm`, which is unreliable or blocked on
 * Obsidian **mobile** (and doesn't render inside an already-open Modal). Resolves `true` if the user
 * confirms, `false` on Cancel / Esc / closing the modal. The resolve is idempotent — closing twice can't
 * double-resolve. The button actions (`confirm`/`cancel`) are public so they can be driven directly in
 * unit tests without simulating DOM clicks.
 */
export class ConfirmModal extends Modal {
	private result = false;
	private resolve: ((v: boolean) => void) | undefined;

	constructor(
		app: App,
		private readonly opts: ConfirmOptions,
	) {
		super(app);
	}

	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.opts.title });
		contentEl.createEl("p", { text: this.opts.body });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.cancel()))
			.addButton((b) => {
				b.setButtonText(this.opts.cta).onClick(() => this.confirm());
				if (this.opts.danger) b.setWarning();
				else b.setCta();
			});
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolve?.(this.result);
		this.resolve = undefined; // idempotent: a second close can't resolve again
	}

	/** The confirm button's action. */
	confirm(): void {
		this.result = true;
		this.close(); // → onClose resolves with `true`
	}

	/** The cancel button's action. */
	cancel(): void {
		this.result = false;
		this.close();
	}
}

/** Open a confirmation dialog and resolve to the user's choice. */
export function confirmModal(app: App, opts: ConfirmOptions): Promise<boolean> {
	return new ConfirmModal(app, opts).ask();
}
