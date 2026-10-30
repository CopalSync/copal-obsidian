import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import { log } from "./log";
import type CopalPlugin from "./main";
import { confirmModal } from "./ui/confirm";
import { userMessage } from "./ui/user-error";

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

		if (!this.plugin.store.isConnected()) {
			this.renderConnect(containerEl); // not signed in → Log in
			return;
		}

		/*
		 * ⛔ **THE ONLY ROUTE BACK FOR AN INSTALL THAT PREDATES `offline_access`.**
		 *
		 * Such an install holds a token it cannot renew. It is still `isConnected()`, so the block
		 * above never fires and the Log in button is never shown — meaning without this branch the
		 * whole fix ships INERT for exactly the people who have the bug. `flow.start()` re-registers
		 * the client (the stored one was registered with the old, narrower scope and would be refused
		 * `invalid_scope`) and signs in again, keeping the vault link.
		 *
		 * Self-deleting: once re-authenticated, `needsReauth()` can never be true again.
		 */
		if (this.plugin.store.needsReauth()) {
			new Setting(containerEl)
				.setName("Sign in again")
				.setDesc(
					"This sign-in can't renew itself, so syncing will stop when it expires. Signing in " +
						"again fixes it for good and keeps this vault linked.",
				)
				.addButton((b) =>
					b
						.setButtonText("Sign in again")
						.setCta()
						.onClick(async () => {
							try {
								await this.plugin.flow.start();
							} catch (err) {
								log.error("re-auth failed", err);
								new Notice(`Copal: ${userMessage(err)}`);
							}
						}),
				);
		}

		if (!this.plugin.store.getVaultId()) {
			// Signed in, but this folder isn't linked to a vault (the adopt screen was closed). Nothing syncs.
			new Setting(containerEl)
				.setName("Not syncing")
				.setDesc(
					"Signed in, but this folder is not linked to a Copal vault. Upload your local files, " +
						"or adopt an existing vault.",
				)
				.addButton((b) =>
					b.setButtonText("Sign out").onClick(async () => {
						new Notice("Signing out…");
						// Silent on success here (the screen changing is the feedback), but a sign-in that
						// could not be revoked is never silent.
						if ((await this.plugin.signOut()) === "failed") {
							new Notice(
								"Signed out on this device. Copal could not be reached, so the sign-in was not " +
									"revoked. Sign out again when you are online.",
								10000,
							);
						}
					}),
				)
				.addButton((b) =>
					b
						.setButtonText("Sync")
						.setCta()
						.onClick(async () => {
							await this.plugin.connectVault(); // re-opens the adopt screen
						}),
				);
			return;
		}

		const vaultName = this.plugin.store.getVaultName();
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
					const outcome = await this.plugin.signOut();
					// Honest either way. A failed revoke still signs you out HERE, but every copy of this
					// vault keeps a sign-in that can renew itself, so it has to be said rather than
					// covered by the same cheerful notice as a clean one.
					new Notice(
						outcome === "failed"
							? "Signed out on this device. Copal could not be reached, so the sign-in was not " +
									"revoked. Sign out again when you are online."
							: "Signed out. Sign back in to resume.",
						outcome === "failed" ? 10000 : undefined,
					);
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

		// Credential-storage transparency (S4): the sign-in is in Obsidian's secret store on this device,
		// never in the vault folder (NV33), so a synced copy of the vault carries none.
		containerEl.createEl("p", {
			cls: "copal-fineprint",
			text:
				"Your Copal sign-in is kept in Obsidian's secure storage on this device, not in the vault " +
				"folder, so a copy of this vault carries no sign-in. Signing out asks Copal to revoke it, " +
				"and tells you if it could not reach Copal to do so. Access already granted can take up " +
				"to an hour to lapse.",
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
							log.error("connect failed", err);
							new Notice(`Copal: ${userMessage(err)}`);
						}
					}),
			);
	}
}
