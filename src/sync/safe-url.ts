/**
 * A URL that has been checked against {@link asTrustedUrl}'s policy. `asTrustedUrl` is the only way to
 * make one, so a field or parameter typed `TrustedUrl` cannot hold something a server just told us —
 * a new sink that forgets to validate fails `tsc` rather than review, and CI runs `pnpm typecheck`.
 */
export type TrustedUrl = string & { readonly __trustedUrl: unique symbol };

/** `copal.uk` and its subdomains, and nothing that merely looks like one. */
const ROOT = "copal.uk";

/**
 * The one policy, shared by every server-supplied URL the plugin acts on, whatever the scheme.
 *
 * Requires the given scheme; the host to be `copal.uk` or a subdomain; no embedded credentials; and no
 * explicit port. Deliberately narrower than "a valid URL": the plugin talks to exactly one deployment,
 * so anything else is either a mistake or an attack, and there is no loopback exception to soften it.
 *
 * ⚠️ Kept as ONE function on purpose. The scheme check and the host check used to live apart — the
 * discovery chain got the full policy while the WebSocket URL next door got `startsWith("wss://")` and
 * nothing else, so `https://evil.com` was refused and `wss://evil.com` was not. Splitting them again
 * recreates that.
 */
function checkUrl(raw: string | undefined, scheme: "https:" | "wss:"): URL {
	if (raw === undefined) throw new Error("untrusted url: missing");
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new Error(`untrusted url: not a URL (${raw})`);
	}
	if (u.protocol !== scheme) throw new Error(`untrusted url: expected ${scheme} (${raw})`);
	// `user:pass@host` reads as the host to a human and resolves to whatever follows the `@`.
	if (u.username !== "" || u.password !== "")
		throw new Error(`untrusted url: credentials (${raw})`);
	// `URL` normalises the default port away, so this only rejects a genuinely unusual one.
	if (u.port !== "") throw new Error(`untrusted url: explicit port (${raw})`);
	// `endsWith(".copal.uk")` alone accepts the empty label in `https://.copal.uk`, so require one.
	const sub = u.hostname.endsWith(`.${ROOT}`) && u.hostname.length > ROOT.length + 1;
	if (u.hostname !== ROOT && !sub) throw new Error(`untrusted url: host (${raw})`);
	return u;
}

/**
 * Assert a SERVER-SUPPLIED URL belongs to Copal before anything is sent to it or opened.
 *
 * OAuth discovery is a chain of documents naming the next hop, and only the first link is ours by
 * construction (`API_BASE` is compiled in). Everything after it — the authorization server, and every
 * endpoint that server publishes — arrives as a string in a JSON body. Those strings receive the
 * authorization code and PKCE verifier, the refresh token twice over, and one of them is opened as a
 * URL, which on mobile means a real `<a href>` the WebView will honour. `javascript:` reaches that sink.
 *
 * Combined with the RFC 8414 issuer check in `discover()` — every endpoint sharing the issuer's origin —
 * the whole chain collapses to a single Copal origin, so a poisoned document cannot redirect one
 * endpoint at a time.
 *
 * Reaching any of this needs control of what `api.copal.uk` serves, or a broken TLS connection. It is
 * not remote-unauthenticated. What makes it worth a type is the blast radius: one bad response hands
 * over every install's long-lived refresh token, and the plugin keeps working while it happens.
 *
 * Throws on anything else. Callers in `oauth.ts` let it propagate (sign-in fails closed); sign-out's
 * revoke degrades to `"failed"` rather than crashing.
 */
export function asTrustedUrl(raw: string | undefined): TrustedUrl {
	checkUrl(raw, "https:");
	return raw as TrustedUrl;
}

/**
 * Assert a SERVER-SUPPLIED WebSocket URL is safe before it is handed to `new WebSocket`.
 *
 * The URL is minted by the (HTTPS) ticket endpoint, so it is trusted twice over in theory and neither
 * time in practice. Two distinct things can go wrong and this refuses both: a **downgrade** to cleartext
 * `ws://`, which would put note text on the wire in the clear; and a **redirection** to another host,
 * which the scheme check alone said nothing about. That second one was the real gap — a compromised or
 * misconfigured ticket endpoint could return a perfectly valid `wss://` pointing anywhere, and the
 * realtime channel would open to it, encrypted, carrying the vault, with nothing to show for it.
 *
 * Callers wrap the socket open in a try/catch that fails closed to a reconnect (offline), so neither
 * ever connects.
 */
export function assertWssUrl(url: string): void {
	checkUrl(url, "wss:");
}
