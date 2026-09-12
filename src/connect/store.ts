import type { Tokens } from "../types";

/** The plugin's persisted state (Obsidian `data.json`). */
export interface PersistedData {
	/** The dynamically-registered OAuth client id — kept across disconnects so re-connect reuses it.
	 *  ⚠️ DISCARDED when a connect attempt is started while `connectAttemptPending` is still set: see
	 *  the note on `ConnectFlow.start`. A registration the server has forgotten is otherwise a dead
	 *  end with no way out from inside the plugin. */
	clientId?: string;
	/**
	 * The scope `clientId` was REGISTERED with — the registration's identity, not a preference.
	 *
	 * ⛔ `/oauth2/authorize` validates the requested scope against `client.scopes` as captured at
	 * registration, so a client registered with one scope can never be authorized with another: it
	 * is refused with `invalid_scope` before any redirect we can observe. Reusing a registration is
	 * therefore only safe when it was made with the scope we are about to ask for, and this field is
	 * how `ConnectFlow.start` knows. `undefined` means "registered before this was recorded", which
	 * is not the same as "matches" — see the migration note there.
	 */
	clientScope?: string;
	/** Set when a connect attempt opens the browser, cleared when the callback lands. Still set at
	 *  the start of the next attempt means the last one died somewhere the plugin cannot see —
	 *  `/oauth2/authorize` refusing an unknown client never reaches our redirect. */
	connectAttemptPending?: boolean;
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

	/** `undefined` discards it, which is how a registration the server has forgotten gets replaced. */
	async setClientId(id: string | undefined): Promise<void> {
		const data = await this.read();
		// `exactOptionalPropertyTypes` is on, so discarding means REMOVING the key rather than setting
		// it to undefined — the two are different types here and only one of them round-trips as JSON.
		if (id === undefined) {
			const { clientId: _discarded, ...rest } = data;
			await this.save(rest);
			return;
		}
		await this.save({ ...data, clientId: id });
	}

	async getClientScope(): Promise<string | undefined> {
		return (await this.read()).clientScope;
	}

	/**
	 * Record a fresh registration: the id and the scope it was made with, in ONE write.
	 *
	 * ⚠️ One write, not two. `data.json` is rewritten concurrently by `SyncState`, `MutationQueue`,
	 * `BinaryCursor` and the binary queue, each doing its own read-modify-write; and a crash between
	 * two sequential mutators would leave an id with no scope, which reads as "stale" and
	 * re-registers on every single connect thereafter.
	 */
	async setClientRegistration(id: string, scope: string): Promise<void> {
		await this.save({ ...(await this.read()), clientId: id, clientScope: scope });
	}

	/** Discard the registration entirely — both keys, one write. See `setClientRegistration`. */
	async clearClientRegistration(): Promise<void> {
		const { clientId: _id, clientScope: _scope, ...rest } = await this.read();
		await this.save(rest);
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
	async needsReauth(): Promise<boolean> {
		const tokens = (await this.read()).tokens;
		return tokens?.access_token !== undefined && tokens.refresh_token === undefined;
	}

	async isConnected(): Promise<boolean> {
		return Boolean((await this.read()).tokens?.access_token);
	}

	/**
	 * `undefined` means this install has never recorded one — it was written by a build that predates
	 * the mark — which is NOT the same as `false` and the difference decides whether a stored
	 * registration can be trusted. See `ConnectFlow.start`.
	 */
	async getConnectAttemptPending(): Promise<boolean | undefined> {
		return (await this.read()).connectAttemptPending;
	}

	async setConnectAttemptPending(pending: boolean): Promise<void> {
		await this.save({ ...(await this.read()), connectAttemptPending: pending });
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
