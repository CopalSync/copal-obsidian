import type { PersistedData, PluginDataStore } from "../data/plugin-data-store";
import type { Tokens } from "../types";
import type { CredentialStore } from "./credential-store";

export type { PersistedData };

/**
 * The connect-side view of the plugin's state: the sign-in, from this device's secret store, and the
 * vault link, from `data.json`.
 *
 * ⛔ **The sign-in never touches `data.json` (audit NV33).** That file is inside the vault folder and
 * travels with every copy of it; the credential lives in {@link CredentialStore}, which is per device
 * and outside the folder. The vault link stays in `data.json` on purpose: it describes the FOLDER, so a
 * second device syncing the same folder resumes the same vault once it signs in.
 *
 * ⚠️ **Reads are synchronous, and that is the honest signature.** Both stores answer from memory
 * (Obsidian's secret store keeps its decrypted map in memory), so an `await` here would not mean a read.
 * Mutators stay async: callers already await them, and the vault link's resolve when the bytes are on
 * disk.
 */
export class TokenStore {
	constructor(
		private readonly data: PluginDataStore,
		private readonly credentials: CredentialStore,
	) {}

	getClientId(): string | undefined {
		return this.credentials.signedIn()?.clientId;
	}

	getTokens(): Tokens | undefined {
		return this.credentials.signedIn()?.tokens;
	}

	/** Sign-in landed: record the credential and the client it was issued to, together. */
	async completeSignIn(tokens: Tokens, clientId: string): Promise<void> {
		this.credentials.setSignedIn({ tokens, clientId });
	}

	/**
	 * A refresh rotated the tokens. It updates a sign-in that exists and never creates one: a rotation
	 * that resolves after sign-out has nothing to update, which backs `TokenManager`'s `abandoned` latch
	 * (C14) rather than relying on it alone.
	 */
	async setTokens(tokens: Tokens): Promise<void> {
		const current = this.credentials.signedIn();
		if (current === undefined) return;
		this.credentials.setSignedIn({ ...current, tokens });
	}

	getLegacyCrdtPurged(): boolean {
		return this.data.read().legacyCrdtPurged === true;
	}

	async markLegacyCrdtPurged(): Promise<void> {
		await this.data.update((d) => {
			d.legacyCrdtPurged = true;
		});
	}

	getVaultId(): string | undefined {
		return this.data.read().vaultId;
	}

	getVaultName(): string | undefined {
		return this.data.read().vaultName;
	}

	/** Link this Obsidian folder to a Copal vault (the connect flow: create-and-push, or adopt). */
	async setVault(vaultId: string, vaultName: string): Promise<void> {
		await this.data.update((d) => {
			d.vaultId = vaultId;
			d.vaultName = vaultName;
		});
	}

	/**
	 * Sign out: drop the credential but **keep the vault link**. Signing back in resumes the same vault
	 * exactly as it was — the everyday pause/re-auth. Revoking it first is `tearDownCredential`'s job.
	 */
	async signOut(): Promise<void> {
		this.credentials.setSignedIn(undefined);
	}

	/**
	 * Unlink the vault (drop `vaultId`/`vaultName`) but **stay signed in**. Used when the linked vault no
	 * longer exists on the account (deleted, or a different account after sign-in) so the folder reconnects.
	 */
	async unlinkVault(): Promise<void> {
		await this.data.update((d) => {
			delete d.vaultId;
			delete d.vaultName;
		});
	}

	/**
	 * Signed in on a credential that CANNOT be renewed — an access token with no refresh token.
	 *
	 * This is the state every install was in before `offline_access` was added to `SCOPE`: it works
	 * until the access token expires, then 401s forever with no way back except signing out and in.
	 * Two things consume it — a notice on load, and the "Sign in again" button in settings, which is
	 * the ONLY route back for someone whose token is still valid (the connect screen renders only
	 * when disconnected, so without it the fix would ship inert for exactly the affected users).
	 *
	 * Self-deleting: once an install has re-authenticated it can never re-enter this state.
	 */
	needsReauth(): boolean {
		const tokens = this.getTokens();
		return tokens?.access_token !== undefined && tokens.refresh_token === undefined;
	}

	isConnected(): boolean {
		return Boolean(this.getTokens()?.access_token);
	}
}
