import type { App, SecretStorage } from "obsidian";
import type { Tokens } from "../types";

/**
 * Where this device keeps its Copal sign-in: Obsidian's secret store, never the vault folder (audit NV33).
 *
 * ⛔ **The sign-in used to live in `data.json`**, which is `.obsidian/plugins/copal/` INSIDE the vault
 * folder. Every copy of the folder — Obsidian Sync with plugin sync on, iCloud, Dropbox, a git remote —
 * therefore carried an account-wide credential: read and write on every vault of the account, renewable
 * for a sliding 14 days. The README disclosed it on the grounds that Obsidian had no secret store.
 *
 * It has one since 1.11.4, and this uses it. Read out of Obsidian 1.14.5 itself: on desktop
 * `app.secretStorage` keeps every secret in one blob encrypted with Electron's `safeStorage` (the key in
 * the OS keychain) under the vault's own localStorage; on Linux with no keyring it falls back to plain
 * text there and warns the person itself; on mobile it is the native Keychain or Keystore. In every case
 * it is per device and outside the folder, so nothing that copies the folder copies the sign-in.
 *
 * ⚠️ **The secret's id is random, and remembered per vault.** On mobile the store is one namespace for
 * the whole app, so a fixed id would make two vaults on one phone share — and overwrite — one sign-in.
 * The id lives in `app.saveLocalStorage`, which Obsidian scopes to this vault on this device. Lose it
 * and the device simply signs in again under a new one.
 *
 * ⚠️ The public API has no delete, so a cleared sign-in is an empty secret.
 */

/** The part of Obsidian's `SecretStorage` this uses. */
export type SecretPort = Pick<SecretStorage, "getSecret" | "setSecret">;
/** Obsidian's per-vault, per-device localStorage. */
export type LocalPort = Pick<App, "loadLocalStorage" | "saveLocalStorage">;

/** The credential: tokens and the OAuth client they were issued to, which every refresh and revoke presents. */
export interface Credential {
	tokens: Tokens;
	clientId: string;
}

/** A refresh token that must be revoked at the authorization server, and its client. */
export interface PendingRevoke {
	refresh_token: string;
	clientId: string;
}

interface Stored {
	signedIn?: Credential;
	revoke?: PendingRevoke[];
}

const ID_KEY = "copal-sign-in";
const ID = /^copal-sign-in-[0-9a-f]{12}$/;

export class CredentialStore {
	private readonly id: string;

	constructor(
		private readonly secrets: SecretPort,
		local: LocalPort,
		randomHex: () => string = () => crypto.randomUUID().replaceAll("-", ""),
	) {
		const known: unknown = local.loadLocalStorage(ID_KEY);
		if (typeof known === "string" && ID.test(known)) {
			this.id = known;
		} else {
			this.id = `copal-sign-in-${randomHex().slice(0, 12)}`;
			local.saveLocalStorage(ID_KEY, this.id);
		}
	}

	/**
	 * Read through on every call: the person can delete the secret in Settings → Keychain at any time,
	 * and a cached copy would keep using a sign-in they removed.
	 */
	private read(): Stored {
		const raw = this.secrets.getSecret(this.id);
		if (raw === null || raw === "") return {};
		try {
			return JSON.parse(raw) as Stored;
		} catch {
			return {};
		}
	}

	private write(next: Stored): void {
		const empty = next.signedIn === undefined && (next.revoke ?? []).length === 0;
		this.secrets.setSecret(this.id, empty ? "" : JSON.stringify(next));
	}

	signedIn(): Credential | undefined {
		return this.read().signedIn;
	}

	setSignedIn(credential: Credential | undefined): void {
		const { signedIn: _replaced, ...rest } = this.read();
		this.write(credential === undefined ? rest : { ...rest, signedIn: credential });
	}

	pendingRevokes(): readonly PendingRevoke[] {
		return this.read().revoke ?? [];
	}

	addPendingRevoke(pending: PendingRevoke): void {
		const stored = this.read();
		const revoke = stored.revoke ?? [];
		if (revoke.some((p) => p.refresh_token === pending.refresh_token)) return;
		this.write({ ...stored, revoke: [...revoke, pending] });
	}

	dropPendingRevoke(refreshToken: string): void {
		const stored = this.read();
		this.write({
			...stored,
			revoke: (stored.revoke ?? []).filter((p) => p.refresh_token !== refreshToken),
		});
	}
}
