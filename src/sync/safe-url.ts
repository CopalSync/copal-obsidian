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

/**
 * A URL that has been checked against {@link asTrustedUrl}'s policy. `asTrustedUrl` is the only way to
 * make one, so a field or parameter typed `TrustedUrl` cannot hold something a server just told us —
 * a new sink that forgets to validate fails `tsc` rather than review, and CI runs `pnpm typecheck`.
 */
export type TrustedUrl = string & { readonly __trustedUrl: unique symbol };

/** `copal.uk` and its subdomains, and nothing that merely looks like one. */
const ROOT = "copal.uk";

/**
 * Assert a SERVER-SUPPLIED URL belongs to Copal before anything is sent to it or opened.
 *
 * OAuth discovery is a chain of documents naming the next hop, and only the first link is ours by
 * construction (`API_BASE` is compiled in). Everything after it — the authorization server, and every
 * endpoint that server publishes — arrives as a string in a JSON body. Those strings receive the
 * authorization code and PKCE verifier, the refresh token twice over, and one of them is opened as a
 * URL, which on mobile means a real `<a href>` the WebView will honour. `javascript:` reaches that sink.
 *
 * The policy is deliberately narrower than "a valid URL": `https` only, the host is `copal.uk` or a
 * subdomain of it, no embedded credentials, and no explicit port. Combined with the RFC 8414 issuer
 * check in `discover()` — every endpoint sharing the issuer's origin — the whole chain collapses to a
 * single Copal origin, so a poisoned document cannot redirect one endpoint at a time.
 *
 * Reaching any of this needs control of what `api.copal.uk` serves, or a broken TLS connection. It is
 * not remote-unauthenticated. What makes it worth a type is the blast radius: one bad response hands
 * over every install's long-lived refresh token, and the plugin keeps working while it happens.
 *
 * Throws on anything else. Callers in `oauth.ts` let it propagate (sign-in fails closed); sign-out's
 * revoke degrades to `"failed"` rather than crashing.
 */
export function asTrustedUrl(raw: string | undefined): TrustedUrl {
	if (raw === undefined) throw new Error("untrusted url: missing");
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new Error(`untrusted url: not a URL (${raw})`);
	}
	if (u.protocol !== "https:") throw new Error(`untrusted url: not https (${raw})`);
	// `user:pass@host` reads as the host to a human and resolves to whatever follows the `@`.
	if (u.username !== "" || u.password !== "")
		throw new Error(`untrusted url: credentials (${raw})`);
	// `URL` normalises the default port away, so this only rejects a genuinely unusual one.
	if (u.port !== "") throw new Error(`untrusted url: explicit port (${raw})`);
	// `endsWith(".copal.uk")` alone accepts the empty label in `https://.copal.uk`, so require one.
	const sub = u.hostname.endsWith(`.${ROOT}`) && u.hostname.length > ROOT.length + 1;
	if (u.hostname !== ROOT && !sub) throw new Error(`untrusted url: host (${raw})`);
	return raw as TrustedUrl;
}
