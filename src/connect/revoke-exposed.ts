import { log } from "../log";
import { withBudget } from "../sync/with-timeout";
import type { CredentialStore } from "./credential-store";
import { discover, revoke } from "./oauth";

/** The same bound as a sign-out's revoke: a start that waits on the network for ever is worse. */
const REVOKE_BUDGET_MS = 4_000;

/**
 * Revoke every sign-in found in the vault folder (audit NV33), and forget each one only once the
 * authorization server has taken it back.
 *
 * Each was copied wherever the folder went, so revoking it is the only thing that makes those copies
 * useless: deleting this device's copy would leave every other one able to renew itself for 14 days. A
 * revoke that fails (offline, a captive portal) stays in this device's secret store and is tried again
 * at the next start. RFC 7009 answers 200 for a token already dead, so a token another device has since
 * rotated is dropped on the first answer like any other.
 *
 * ⚠️ Revoking a refresh token cannot recall an access token already issued from it; that one lives out
 * its hour, as after any sign-out.
 */
export async function revokeExposed(
	credentials: CredentialStore,
	f: typeof fetch,
): Promise<{ revoked: number; left: number }> {
	const pending = credentials.pendingRevokes();
	if (pending.length === 0) return { revoked: 0, left: 0 };
	const attempt = async (): Promise<number> => {
		const endpoint = (await discover(f)).revocation_endpoint;
		if (endpoint === undefined)
			throw new Error("the authorization server publishes no revocation endpoint");
		let revoked = 0;
		for (const { refresh_token: token, clientId } of pending) {
			// oxlint-disable-next-line no-await-in-loop -- one at a time: each is forgotten only once taken back
			await revoke(f, endpoint, clientId, token);
			credentials.dropPendingRevoke(token);
			revoked += 1;
		}
		return revoked;
	};
	const revoked = await withBudget(
		attempt().catch((err: unknown) => {
			log.warn("[copal] could not revoke a sign-in found in the vault folder; will retry:", err);
			return 0;
		}),
		REVOKE_BUDGET_MS,
		0,
	);
	return { revoked, left: credentials.pendingRevokes().length };
}
