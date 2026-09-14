import type { TokenStore } from "../connect/store";
import { asVaultId, LocalDocStore } from "./local-doc-store";
import { LocalNoteRegistry } from "./local-note-registry";
import type { VaultWriter } from "../sync/vault";

/**
 * Wire a `LocalNoteRegistry` to the vault this folder is actually linked to.
 *
 * ⛔ **THIS FACTORY EXISTS TO BE TESTED.** The bug it closes was never in `LocalDocStore`, which keyed
 * databases correctly and had a test proving it. The bug was one argument in `main.ts` — the literal
 * `"vault"` — and `main.ts` has no tests, so nothing could see it. Putting the wiring here means
 * `create-registry.test.ts` drives the real thing: a store built from a `TokenStore` with a vault id,
 * asserting the database name that comes out.
 *
 * The id is read through a thunk, not captured, because `onload` runs before a folder is linked. An
 * unlinked folder therefore throws from `asVaultId` at the moment a doc is opened, which is correct:
 * there is nowhere to persist it, and inventing a default tenant is the original bug.
 */
export function createLocalNoteRegistry(
	store: Pick<TokenStore, "getVaultId">,
	vault: VaultWriter,
): LocalNoteRegistry {
	return new LocalNoteRegistry(
		new LocalDocStore(() => Promise.resolve(asVaultId(store.getVaultId()))),
		vault,
	);
}
