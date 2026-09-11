import { describe, expect, it } from "vitest";
import { decideConnect } from "../../src/connect/decide";
import type { Vault } from "../../src/sync/api";

const vault = (vaultId: string): Vault => ({
	vaultId,
	displayName: vaultId,
	createdAt: 0,
});

describe("decideConnect", () => {
	it("no vaults → create (sync this folder up as the first vault)", () => {
		expect(decideConnect([]).kind).toBe("create");
	});

	it("one vault → ask (the screen offers upload AND use-an-existing)", () => {
		// This used to assert "never offer create when a vault already exists", which was the old rule
		// and left somebody with notes in both places unable to keep both. The decision here is only
		// whether to ASK; `VaultChoiceModal` owns what the options are.
		expect(decideConnect([vault("vlt_1")]).kind).toBe("ask");
	});

	it("multiple vaults → ask", () => {
		expect(decideConnect([vault("vlt_1"), vault("vlt_2")]).kind).toBe("ask");
	});
});
