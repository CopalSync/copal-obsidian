import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CopalPlugin from "./main";
import { confirmModal } from "./ui/confirm";

/** Settings tab: a single Connect / Disconnect control reflecting the stored token state. */
export class CopalSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: CopalPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		void this.render();
	}

	/** Re-render after the connect/disconnect state changes. */
	async refresh(): Promise<void> {
		await this.render();
	}

	private async render(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		// ⚠️ No plugin-name heading here. Obsidian already renders "Copal" as the settings tab's
		// title, so an <h2> repeated it — and the review guidelines ask for `setHeading()` over a raw
		// heading element, and for section headings only when there are several sections.

		if (!(await this.plugin.store.isConnected())) {
			this.renderConnect(containerEl); // not signed in → Log in
			return;
		}

		if (!(await this.plugin.store.getVaultId())) {
			// Signed in, but this folder isn't linked to a vault (the adopt screen was closed). Nothing syncs.
			new Setting(containerEl)
				.setName("This folder is not syncing yet")
				.setDesc(
					"You are signed in. This folder is not connected to one of your Copal vaults, so nothing " +
						"is being synced. Choose a vault to sync it with. Its notes will replace what is in " +
						"this folder, and the files that are here now move to Obsidian trash. To keep them, " +
						"make a new empty vault in Obsidian and connect Copal from there instead.",
				)
				.addButton((b) =>
					b.setButtonText("Sign out").onClick(async () => {
						new Notice("Signing out…");
						await this.plugin.signOut();
					}),
				)
				.addButton((b) =>
					b
						.setButtonText("Choose a vault")
						.setCta()
						.onClick(async () => {
							await this.plugin.connectVault(); // re-opens the adopt screen
						}),
				);
			return;
		}

		const vaultName = await this.plugin.store.getVaultName();
		new Setting(containerEl)
			.setName("Connected")
			.setDesc(
				`This folder syncs to the Copal vault "${vaultName ?? "your vault"}". Sign out to pause. Sign ` +
					`back in and it resumes here. Disconnect to unlink this folder entirely; next login you'll ` +
					`adopt a vault. Either way your Markdown files stay.`,
			)
			.addButton((b) =>
				b.setButtonText("Sign out").onClick(async () => {
					new Notice("Signing out…");
					await this.plugin.signOut();
					new Notice("Signed out. Sign back in to resume.");
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Disconnect")
					.setWarning()
					.onClick(async () => {
						// A cross-platform Modal confirm (works on desktop + mobile, unlike `window.confirm`).
						// Disconnect is destructive-ish (unlinks + wipes local sync state), so confirm first.
						const ok = await confirmModal(this.app, {
							title: "Disconnect this folder from Copal?",
							body:
								"It unlinks from the vault and clears Copal's local sync state. Your Markdown files stay. " +
								"Next login you'll pick a vault to adopt. Pending edits are pushed first.",
							cta: "Disconnect",
							danger: true,
						});
						if (!ok) return;
						new Notice("Disconnecting…");
						await this.plugin.disconnect();
						new Notice("Disconnected. Your notes are kept as files.");
					}),
			);

		// Credential-storage transparency (S4): tokens live in this vault's plugin data (Obsidian has no
		// cross-platform secret store). If the vault itself is synced elsewhere, the sign-in travels with it.
		containerEl.createEl("p", {
			cls: "copal-fineprint",
			text:
				"Your Copal sign-in is stored in this vault's plugin data. If you sync this vault elsewhere " +
				"(iCloud, Obsidian Sync, git…), your sign-in travels with it. Sign out on devices you no longer use.",
		});
	}

	private renderConnect(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Sign in to Copal")
			.setDesc("Sign in with a one-time link. There is no token to paste.")
			.addButton((b) =>
				b
					.setButtonText("Log in")
					.setCta()
					.onClick(async () => {
						try {
							await this.plugin.flow.start();
							new Notice("Opening sign-in… finish in your browser.");
						} catch (err) {
							new Notice(
								`Copal connect failed: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}),
			);
	}
}
