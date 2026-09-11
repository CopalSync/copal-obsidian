import type { Vault } from "../sync/api";

/** What connecting an *unlinked* Obsidian folder should do, given the account's existing vaults. */
export type ConnectDecision =
	| { kind: "create" } // zero vaults → nothing to choose between: push this folder up, no screen
	| { kind: "ask" }; // vaults exist → show the choice screen (upload this folder, or use one of them)

/**
 * Whether connecting an unlinked folder needs to ASK.
 *
 * No vaults: there is nothing to choose between, so this folder becomes the first one and is pushed
 * up without a screen. Any vaults: show the choice screen.
 *
 * ⚠️ **`adopt` no longer means "adopt is the only option".** It used to: the screen offered exactly
 * one move, and a person with notes here and notes in Copal could only replace one with the other.
 * `VaultChoiceModal` now offers uploading this folder as a new vault as well, so this function has
 * narrowed to the question it can actually answer on its own, which is whether to ask at all.
 */
export function decideConnect(vaults: Vault[]): ConnectDecision {
	return vaults.length === 0 ? { kind: "create" } : { kind: "ask" };
}
