/**
 * The contract, run against BOTH `VaultWriter` implementations.
 *
 * `InMemoryVault` is what nine test files drive the sync engine with; `ObsidianVault` is what ships.
 * Running one suite against both is what stops them drifting — and it immediately found two places
 * where the fake was a more permissive world than production (see its own file for the fixes).
 */
import { describe } from "vitest";
import { ObsidianVault } from "../../src/sync/obsidian-vault";
import { stubApp, vaultOf } from "../stubs/obsidian";
import { InMemoryVault } from "./fake-vault";
import { describeVaultWriterContract, type VaultUnderTest } from "./vault-contract";

describe("VaultWriter contract — InMemoryVault", () => {
	describeVaultWriterContract((): VaultUnderTest => {
		const vault = new InMemoryVault();
		return {
			vault,
			seed: (path, content) => vault.__seed(path, content),
			snapshot: () => vault.snapshot(),
		};
	});
});

describe("VaultWriter contract — ObsidianVault over the obsidian double", () => {
	describeVaultWriterContract((): VaultUnderTest => {
		const app = stubApp();
		const stub = vaultOf(app);
		return {
			vault: new ObsidianVault(app),
			seed: (path, content) => void stub.__put(path, { text: content }),
			snapshot: () => stub.snapshot(),
		};
	});
});
