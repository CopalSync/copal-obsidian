import type { Vault } from "../sync/api";

/** What connecting an *unlinked* Obsidian folder should do, given the account's existing vaults. */
export type ConnectDecision =
	| { kind: "create" } // zero vaults → this is the first: sync this folder up as a new vault (no screen)
	| { kind: "adopt" }; // one or more vaults exist → show the adopt screen; the only way to join is to adopt

/**
 * The whole connect rule for a folder that isn't linked yet: if the account has **no** vaults, this folder
 * becomes the first one (create + push, no screen). If it already has **any** vault, the only move is to
 * **adopt** one — there is deliberately no "create a second vault from this folder" path in the plugin.
 * (A folder that *is* already linked never reaches here — it just resumes.)
 */
export function decideConnect(vaults: Vault[]): ConnectDecision {
	return vaults.length === 0 ? { kind: "create" } : { kind: "adopt" };
}
