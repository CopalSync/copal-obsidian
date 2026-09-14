import { describe, expect, it } from "vitest";
import { assertWssUrl, asTrustedUrl } from "../../src/sync/safe-url";

describe("assertWssUrl", () => {
	it("accepts a wss:// URL", () => {
		expect(() => assertWssUrl("wss://api.copal.uk/sync?ticket=x")).not.toThrow();
	});

	for (const bad of [
		"ws://api.copal.uk",
		"http://api.copal.uk",
		"https://api.copal.uk",
		"",
		"wssx://x",
		" wss://x",
	]) {
		it(`rejects ${JSON.stringify(bad)}`, () => {
			expect(() => assertWssUrl(bad)).toThrow(/wss|untrusted/i);
		});
	}

	/**
	 * S7. The scheme check alone said nothing about WHERE the socket connects. The URL is server-supplied
	 * — minted by the ticket endpoint — so a compromised or misconfigured server could hand back a
	 * perfectly valid `wss://` pointing anywhere, and the realtime channel, which carries note text,
	 * would open to it encrypted and unremarked. Same policy as `asTrustedUrl`, different scheme.
	 */
	for (const bad of [
		"wss://evil.com",
		"wss://api.copal.uk.evil.com",
		"wss://xcopal.uk",
		"wss://.copal.uk",
		"wss://api.copal.uk./sync",
		"wss://user:pass@api.copal.uk",
		"wss://api.copal.uk@evil.com",
		"wss://api.copal.uk:8443",
	]) {
		it(`rejects off-host ${JSON.stringify(bad)}`, () => {
			expect(() => assertWssUrl(bad)).toThrow(/untrusted url/i);
		});
	}

	for (const good of ["wss://api.copal.uk/ycrdt?ticket=x", "wss://copal.uk/sync"]) {
		it(`accepts ${JSON.stringify(good)}`, () => {
			expect(() => assertWssUrl(good)).not.toThrow();
		});
	}
});

describe("asTrustedUrl", () => {
	for (const good of [
		"https://copal.uk",
		"https://api.copal.uk/.well-known/oauth-protected-resource/mcp",
		"https://auth.copal.uk/api/auth/oauth2/token",
		"https://auth.copal.uk", // the issuer, which revokeGrant appends a path to
		"https://COPAL.UK", // the URL parser lowercases the host
		"https://copal.uk:443", // the parser normalises the default port away — same origin
	]) {
		it(`accepts ${JSON.stringify(good)}`, () => {
			expect(() => asTrustedUrl(good)).not.toThrow();
		});
	}

	// The falsification list. Each of these reaches a real sink if it gets through: the token endpoint
	// takes the PKCE verifier and the refresh token, and the authorization endpoint is opened as a URL.
	for (const bad of [
		"javascript:alert(1)", // the one that executes — mobile renders the endpoint as a real <a href>
		"data:text/html,<script>alert(1)</script>",
		"http://copal.uk", // a downgrade puts a refresh token on the wire in cleartext
		"https://evil.com",
		"https://copal.uk.evil.com", // the suffix trick a naive `includes` would accept
		"https://xcopal.uk", // and the one a naive `endsWith("copal.uk")` would accept
		"https://.copal.uk", // `endsWith(".copal.uk")` alone accepts this
		"https://auth.copal.uk./x", // trailing dot: a different name to a resolver
		"https://user:pass@copal.uk",
		"https://auth.copal.uk@evil.com", // reads as copal.uk, resolves to evil.com
		"https://copal.uk:8443",
		"",
		"//copal.uk",
		"/.well-known/oauth-authorization-server",
		undefined,
	]) {
		it(`rejects ${JSON.stringify(bad)}`, () => {
			expect(() => asTrustedUrl(bad)).toThrow(/untrusted url/i);
		});
	}
});
