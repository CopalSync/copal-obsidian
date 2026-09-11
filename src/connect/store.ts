import type { Tokens } from "../types";

/** The plugin's persisted state (Obsidian `data.json`). */
export interface PersistedData {
	/** The dynamically-registered OAuth client id — kept across disconnects so re-connect reuses it. */
	clientId?: string;
	tokens?: Tokens;
	/** A stable per-install id so this device's own pushes can be filtered off the live feed. */
	deviceId?: string;
	/** The Copal vault this Obsidian folder is linked to — sent as `X-Copal-Vault`. Set while connected;
	 *  a linked folder resumes on reload/re-auth. **Disconnect clears it** (fully unlink) → the next login
	 *  shows the adopt screen. */
	vaultId?: string;
	vaultName?: string;
}

/**
 * Persists the OAuth client id + tokens via injected `load`/`save` (Obsidian's `loadData`/`saveData`
 * in production, an in-memory pair in tests). Each accessor reads the whole record and each mutator
 * rewrites it, so the store never holds stale in-memory state.
 */
export class TokenStore {
	constructor(
		private readonly load: () => Promise<PersistedData | null>,
		private readonly save: (data: PersistedData) => Promise<void>,
	) {}

	private async read(): Promise<PersistedData> {
		return (await this.load()) ?? {};
	}

	async getClientId(): Promise<string | undefined> {
		return (await this.read()).clientId;
	}

	async setClientId(id: string): Promise<void> {
		await this.save({ ...(await this.read()), clientId: id });
	}

	async getTokens(): Promise<Tokens | undefined> {
		return (await this.read()).tokens;
	}

	async setTokens(tokens: Tokens): Promise<void> {
		await this.save({ ...(await this.read()), tokens });
	}

	async getVaultId(): Promise<string | undefined> {
		return (await this.read()).vaultId;
	}

	async getVaultName(): Promise<string | undefined> {
		return (await this.read()).vaultName;
	}

	/** Link this Obsidian folder to a Copal vault (the connect flow: create-and-push, or adopt). */
	async setVault(vaultId: string, vaultName: string): Promise<void> {
		await this.save({ ...(await this.read()), vaultId, vaultName });
	}

	/**
	 * Sign out: drop the tokens but **keep the vault link** (and the client id). Signing back in resumes the
	 * same vault exactly as it was — the everyday pause/re-auth.
	 */
	async signOut(): Promise<void> {
		const data = { ...(await this.read()) };
		delete data.tokens;
		await this.save(data);
	}

	/**
	 * Unlink the vault (drop `vaultId`/`vaultName`) but **stay signed in**. Used when the linked vault no
	 * longer exists on the account (deleted, or a different account after sign-in) so the folder reconnects.
	 */
	async unlinkVault(): Promise<void> {
		const data = { ...(await this.read()) };
		delete data.vaultId;
		delete data.vaultName;
		await this.save(data);
	}

	async isConnected(): Promise<boolean> {
		return Boolean((await this.read()).tokens?.access_token);
	}

	/** The stable device id, generated + persisted on first use (kept across disconnects). */
	async getDeviceId(): Promise<string> {
		const data = await this.read();
		if (data.deviceId) return data.deviceId;
		const id = crypto.randomUUID();
		await this.save({ ...data, deviceId: id });
		return id;
	}
}
