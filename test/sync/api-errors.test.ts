import { describe, expect, it, vi } from "vitest";
import { ApiError, SyncApi } from "../../src/sync/api";

const api = () => new SyncApi({ f, getToken: async () => "token" });
let f: ReturnType<typeof vi.fn<typeof fetch>>;

/**
 * ⛔ THE PLAN CAP IS A LIKELY OUTCOME, NOT AN EXCEPTIONAL ONE.
 *
 * Solo includes one vault, and the connect screen offering Upload is shown precisely BECAUSE the
 * account already has one. So anybody on Solo who picks Upload lands here. The gateway sends
 * `VAULT_LIMIT_REACHED` as a machine-readable code for exactly this reason — `deps.ts` calls it "the
 * one error that carries a machine-readable code" — and it has to survive as far as the UI, or the
 * only thing left to show is a 403.
 */
describe("createVault at the plan limit", () => {
	it("carries the gateway's code, not just the status", async () => {
		f = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ error: "vault limit reached", code: "VAULT_LIMIT_REACHED" }), {
				status: 403,
			}),
		);
		await expect(api().createVault("x")).rejects.toMatchObject({
			status: 403,
			code: "VAULT_LIMIT_REACHED",
		});
	});

	it("survives an error body that is not JSON", async () => {
		// A proxy or an edge error can return HTML. Reading the code must not turn one failure into
		// two, and the status is still worth having.
		f = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
		const err = await api()
			.createVault("x")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(502);
		expect((err as ApiError).code).toBeUndefined();
	});
});
