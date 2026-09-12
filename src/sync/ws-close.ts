/**
 * The gateway's application close code for a socket it retired on purpose.
 *
 * ⚠️ Duplicated from `copal-gateway/src/sync/ws-lifetime.ts` (`WS_REAUTH_CLOSE`), because the two
 * packages share no client module. It is part of the wire contract: the gateway caps every socket's
 * life at 30 minutes and closes it with this code, expecting the client to re-mint a ticket and
 * reconnect. That is a HEALTHY, scheduled event, not a fault — and treating it as one is why a
 * perfectly normal half-hourly rotation used to flash "offline" at the user, which in turn is why a
 * real outage never stood out from the noise.
 */
export const WS_REAUTH_CLOSE = 4001;

/**
 * The close code, when the event actually carries one.
 *
 * ⚠️ Never assume the event is a well-formed `CloseEvent`. `close` is also dispatched from `error`
 * handlers, and a throw inside a close listener would skip the reconnect that follows it — turning
 * a momentary network blip into a socket that never comes back. Returning `undefined` simply means
 * "treat it as an ordinary drop", which is the safe reading.
 */
export function closeCode(event: unknown): number | undefined {
	const code = (event as { code?: unknown } | null | undefined)?.code;
	return typeof code === "number" ? code : undefined;
}
