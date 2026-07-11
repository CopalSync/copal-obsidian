/**
 * Assert a SERVER-SUPPLIED WebSocket URL is secure (`wss://`) before it's handed to `new WebSocket`.
 * The URL is minted by the (HTTPS) ticket endpoint, but never trusting it to be `wss://` means a
 * compromised or misconfigured server can't silently downgrade the realtime channel to cleartext
 * `ws://`. The plugin only ever talks to `https://api.copal.uk`, so the rule is strict `wss://` — no
 * loopback exception. Throws otherwise; callers wrap the socket open in a try/catch that fails closed to
 * a reconnect (offline), so a downgrade never connects.
 */
export function assertWssUrl(url: string): void {
  if (!url.startsWith("wss://")) {
    throw new Error("insecure socket url (expected wss://)");
  }
}
