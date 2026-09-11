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

	it("one vault → adopt (never offer create when a vault already exists)", () => {
		expect(decideConnect([vault("vlt_1")]).kind).toBe("adopt");
	});

	it("multiple vaults → adopt (pick one to pull down)", () => {
		expect(decideConnect([vault("vlt_1"), vault("vlt_2")]).kind).toBe("adopt");
	});
});
