import type { PersistedData, PluginDataStore } from "../data/plugin-data-store";
import type { Tokens } from "../types";

export type { PersistedData };

/**
 * The connect-side view of the plugin's persisted record.
 *
 * ⚠️ **Reads are synchronous, and that is the honest signature.** This class used to re-read and
 * re-parse the whole of `data.json` on every single getter — a `settings.ts` render was four file
 * loads, a `flow.start()` about six — with a docblock presenting "never holds stale in-memory state"
 * as the design. {@link PluginDataStore} loads once and keeps one canonical record, so an `await` here
 * would no longer mean a read; leaving it would invite `await`-in-a-loop over something free.
 *
 * Mutators stay async: they resolve when the bytes are on disk.
 */
export class TokenStore {
	constructor(private readonly data: PluginDataStore) {}

	getClientId(): string | undefined {
		return this.data.read().clientId;
	}

	getTokens(): Tokens | undefined {
		return this.data.read().tokens;
	}

	/** Sign-in landed: record the credential and the client it was issued to, in ONE write. */
	async completeSignIn(tokens: Tokens, clientId: string): Promise<void> {
		await this.data.update((d) => {
			d.tokens = tokens;
			d.clientId = clientId;
		});
	}

	async setTokens(tokens: Tokens): Promise<void> {
		await this.data.update((d) => {
			d.tokens = tokens;
		});
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
	 * Sign out: drop the tokens but **keep the vault link** (and the client id). Signing back in resumes the
	 * same vault exactly as it was — the everyday pause/re-auth.
	 *
	 * ⛔ This delete is what S3 was about. It used to be `save({ ...(await read()) })` with the key
	 * removed, so any of the four sync persisters holding a read taken before it put the credential
	 * straight back — and `data.json` travels with the vault to iCloud, Obsidian Sync and git. The
	 * mutation now lands on the one canonical record with no read in between, so there is nothing stale
	 * for a concurrent writer to spread.
	 */
	async signOut(): Promise<void> {
		await this.data.update((d) => {
			delete d.tokens;
		});
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
		const tokens = this.data.read().tokens;
		return tokens?.access_token !== undefined && tokens.refresh_token === undefined;
	}

	isConnected(): boolean {
		return Boolean(this.data.read().tokens?.access_token);
	}
}
