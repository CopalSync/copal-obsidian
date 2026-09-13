import { describe, expect, it, vi } from "vitest";
import { asTrustedUrl } from "../../src/sync/safe-url";
import {
	buildAuthorizeUrl,
	SCOPE,
	discover,
	exchangeCode,
	refresh,
	registerClient,
	revoke,
	REDIRECT_URI,
} from "../../src/connect/oauth";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("buildAuthorizeUrl", () => {
	it("builds a PKCE authorize URL with all required params", () => {
		const url = new URL(
			buildAuthorizeUrl(
				asTrustedUrl("https://api.copal.uk/authorize"),
				"cid",
				{ verifier: "v", challenge: "chal" },
				"st8",
			),
		);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBe("cid");
		expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(url.searchParams.get("code_challenge")).toBe("chal");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("scope")).toBe(SCOPE);
		// ⛔ Named explicitly, not just "whatever SCOPE says": this single word is what buys a refresh
		// token, and without it every install dies an hour after signing in. See the note on SCOPE.
		expect(
			url.searchParams.get("scope")?.split(" "),
			"offline_access left the authorize request — sign-ins will expire in an hour with no way to renew",
		).toContain("offline_access");
		expect(url.searchParams.get("state")).toBe("st8");
	});
});

// The gateway is a RESOURCE server and does not serve authorization-server metadata — asking it
// for `/.well-known/oauth-authorization-server` 404s. The authorization server is named by the
// protected-resource document, and only that document knows which host it is. Hardcoding the
// answer is what broke connect in production when the two moved apart.
describe("discover", () => {
	// Production-shaped: `issuer` is present and equal to the origin the document is served from, and
	// every endpoint shares that origin. RFC 8414 §3.3 requires the first; `discover` now enforces both.
	const asMetadata = {
		issuer: "https://auth.copal.uk",
		registration_endpoint: "https://auth.copal.uk/oauth2/register",
		authorization_endpoint: "https://auth.copal.uk/oauth2/authorize",
		token_endpoint: "https://auth.copal.uk/oauth2/token",
	};

	it("follows the protected-resource document to the authorization server", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					resource: "https://api.copal.uk/mcp",
					authorization_servers: ["https://auth.copal.uk"],
				}),
			)
			.mockResolvedValueOnce(jsonResponse(asMetadata));

		const d = await discover(f);

		expect(d.token_endpoint).toBe("https://auth.copal.uk/oauth2/token");
		// RFC 9728 inserts the well-known segment between host and path, so the document for the
		// resource `https://api.copal.uk/mcp` lives under `/.well-known/oauth-protected-resource/mcp`.
		expect(f.mock.calls[0]![0]).toBe(
			"https://api.copal.uk/.well-known/oauth-protected-resource/mcp",
		);
		// The second hop must go to the host the document named, not to the gateway.
		expect(f.mock.calls[1]![0]).toBe(
			"https://auth.copal.uk/.well-known/oauth-authorization-server",
		);
	});

	it("falls back to the bare well-known path", async () => {
		// A gateway that has not yet moved the document to its RFC 9728 location still serves the
		// bare path, so connect must keep working across that deploy.
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404))
			.mockResolvedValueOnce(
				jsonResponse({
					resource: "https://api.copal.uk/mcp",
					authorization_servers: ["https://auth.copal.uk"],
				}),
			)
			.mockResolvedValueOnce(jsonResponse(asMetadata));

		const d = await discover(f);

		expect(d.registration_endpoint).toBe("https://auth.copal.uk/oauth2/register");
		expect(f.mock.calls[1]![0]).toBe("https://api.copal.uk/.well-known/oauth-protected-resource");
	});

	it("refuses a document that names no authorization server", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ resource: "https://api.copal.uk/mcp" }));
		await expect(discover(f)).rejects.toThrow(/authorization server/i);
	});

	it("throws when the resource serves no metadata at either path", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "nope" }, 404));
		await expect(discover(f)).rejects.toThrow();
	});

	/**
	 * S2. Everything after `API_BASE` arrives as a string in a JSON body, and those strings receive the
	 * PKCE verifier, the authorization code and the refresh token — twice over. The tests below assert
	 * the refusal AND that nothing was sent to the hostile host: asserting only the throw would pass
	 * against code that leaks first and validates afterwards.
	 */
	describe("refuses a poisoned chain", () => {
		const prm = (servers: unknown, resource = "https://api.copal.uk/mcp") =>
			jsonResponse({ resource, authorization_servers: servers });

		const hostsCalled = (f: ReturnType<typeof vi.fn<typeof fetch>>) =>
			f.mock.calls.map((c) => new URL(String(c[0])).host);

		it("never contacts an authorization server that is not on copal.uk", async () => {
			const f = vi.fn<typeof fetch>().mockResolvedValue(prm(["https://evil.com"]));

			await expect(discover(f)).rejects.toThrow(/untrusted url/i);
			expect(hostsCalled(f), "the hostile host was contacted before being rejected").not.toContain(
				"evil.com",
			);
		});

		it("never contacts an authorization server reached over http", async () => {
			const f = vi.fn<typeof fetch>().mockResolvedValue(prm(["http://auth.copal.uk"]));

			await expect(discover(f)).rejects.toThrow(/untrusted url/i);
			expect(f.mock.calls.map((c) => String(c[0]))).not.toContain(
				"http://auth.copal.uk/.well-known/oauth-authorization-server",
			);
		});

		it("refuses a look-alike host", async () => {
			const f = vi.fn<typeof fetch>().mockResolvedValue(prm(["https://copal.uk.evil.com"]));
			await expect(discover(f)).rejects.toThrow(/untrusted url/i);
			expect(hostsCalled(f)).not.toContain("copal.uk.evil.com");
		});

		it("refuses metadata whose issuer is not the host that served it (RFC 8414 §3.3)", async () => {
			const f = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(prm(["https://auth.copal.uk"]))
				.mockResolvedValueOnce(jsonResponse({ ...asMetadata, issuer: "https://other.copal.uk" }));

			await expect(discover(f)).rejects.toThrow(/issuer/i);
		});

		it("refuses metadata with an endpoint on a different origin from its issuer", async () => {
			const f = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(prm(["https://auth.copal.uk"]))
				.mockResolvedValueOnce(
					jsonResponse({ ...asMetadata, token_endpoint: "https://other.copal.uk/oauth2/token" }),
				);

			// Same registrable domain, so the URL policy alone would let it through — this is the check
			// that stops one endpoint being redirected at a time.
			await expect(discover(f)).rejects.toThrow(/origin/i);
		});

		it("refuses a javascript: authorization endpoint", async () => {
			const f = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(prm(["https://auth.copal.uk"]))
				.mockResolvedValueOnce(
					jsonResponse({ ...asMetadata, authorization_endpoint: "javascript:alert(1)" }),
				);

			await expect(discover(f)).rejects.toThrow(/untrusted url/i);
		});

		it("refuses a protected-resource document issued for a different resource", async () => {
			const f = vi
				.fn<typeof fetch>()
				.mockResolvedValue(prm(["https://auth.copal.uk"], "https://evil.com/mcp"));

			await expect(discover(f)).rejects.toThrow(/resource/i);
			expect(hostsCalled(f)).not.toContain("auth.copal.uk");
		});

		it("refuses metadata that omits a required endpoint", async () => {
			const { token_endpoint: _omitted, ...withoutToken } = asMetadata;
			const f = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(prm(["https://auth.copal.uk"]))
				.mockResolvedValueOnce(jsonResponse(withoutToken));

			await expect(discover(f)).rejects.toThrow();
		});
	});
});

describe("registerClient", () => {
	it("registers against the https bounce, not obsidian:// — which 1.7 refuses outright", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ client_id: "abc123" }, 201));
		const reg = await registerClient(f, asTrustedUrl("https://api.copal.uk/register"));
		expect(reg.client_id).toBe("abc123");
		const [, init] = f.mock.calls[0]!;
		const body = JSON.parse(init!.body as string) as {
			redirect_uris: string[];
			token_endpoint_auth_method: string;
			application_type: string;
		};
		// A private-use scheme can be claimed by any app, so RFC 8252 §7.1 wants a reverse-domain one
		// and better-auth 1.7 enforces it — `obsidian://copal-connect` is rejected at registration.
		// copal.uk/plugin/connect forwards the code inward instead.
		expect(body.redirect_uris).toEqual([REDIRECT_URI]);
		expect(REDIRECT_URI).toBe("https://copal.uk/plugin/connect");
		expect(body.token_endpoint_auth_method).toBe("none");
		expect(body.application_type).toBe("native");
	});
});

describe("exchangeCode", () => {
	it("posts the authorization_code grant with the verifier and maps expiry", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				access_token: "at",
				refresh_token: "rt",
				scope: "vault.read vault.write",
				expires_in: 3600,
			}),
		);
		const before = Date.now();
		const t = await exchangeCode(
			f,
			asTrustedUrl("https://api.copal.uk/token"),
			"cid",
			"code123",
			"verifier123",
		);
		expect(t.access_token).toBe("at");
		expect(t.refresh_token).toBe("rt");
		expect(t.expires_at).toBeGreaterThanOrEqual(before + 3600_000 - 5000);
		const [, init] = f.mock.calls[0]!;
		const body = new URLSearchParams(init!.body as string);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("code123");
		expect(body.get("code_verifier")).toBe("verifier123");
		expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
	});

	it("throws on a non-ok token response", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
		await expect(
			exchangeCode(f, asTrustedUrl("https://api.copal.uk/token"), "cid", "c", "v"),
		).rejects.toThrow();
	});
});

describe("revoke", () => {
	it("posts the refresh token to the revocation endpoint, form-encoded", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
		await revoke(f, asTrustedUrl("https://auth.copal.uk/oauth2/revoke"), "cid", "rt");
		const [url, init] = f.mock.calls[0]!;
		expect(String(url)).toBe("https://auth.copal.uk/oauth2/revoke");
		expect(init!.method).toBe("POST");
		/*
		 * The provider declares `allowedMediaTypes: ["application/x-www-form-urlencoded"]` and rejects a
		 * JSON body. Asserted as the content type AND a parseable form body, because sending JSON with
		 * the right header would pass a header-only check and still be refused by the server.
		 */
		expect((init!.headers as Record<string, string>)["content-type"]).toBe(
			"application/x-www-form-urlencoded",
		);
		const body = new URLSearchParams(init!.body as string);
		expect(body.get("token")).toBe("rt");
		expect(body.get("token_type_hint")).toBe("refresh_token");
		// A mismatched client id makes the server answer 200 and revoke NOTHING, so the id travelling
		// with the token is the whole difference between a revoke and a silent no-op.
		expect(body.get("client_id")).toBe("cid");
	});

	it("throws on a non-ok response, so a failed revoke can be reported rather than assumed", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
		await expect(
			revoke(f, asTrustedUrl("https://auth.copal.uk/oauth2/revoke"), "cid", "rt"),
		).rejects.toThrow(/503/);
	});
});

describe("refresh", () => {
	it("posts the refresh_token grant", async () => {
		const f = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ access_token: "at2" }));
		const t = await refresh(f, asTrustedUrl("https://api.copal.uk/token"), "cid", "rt");
		expect(t.access_token).toBe("at2");
		const [, init] = f.mock.calls[0]!;
		const body = new URLSearchParams(init!.body as string);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("rt");
	});
});

/**
 * ⛔ RFC 8707. The resource is what makes the access token a JWT with an audience the gateway will
 * accept. `copal-auth` issues an OPAQUE token when there is no audience to assign, and an opaque
 * token cannot be verified offline — it surfaces at the gateway as an ordinary bad-token 401, so
 * sign-in appears to succeed and then every single call fails.
 *
 * All three legs, because omitting it from any one of them reproduces the bug at a different
 * moment: authorize (never consented for the resource), token (opaque from the start), refresh
 * (works for an hour, then opaque with nothing having changed).
 */
describe("the resource indicator", () => {
	it("is on the authorize URL", () => {
		const url = new URL(
			buildAuthorizeUrl(
				asTrustedUrl("https://auth.copal.uk/oauth2/authorize"),
				"cid",
				{ verifier: "v", challenge: "c" },
				"st8",
			),
		);
		expect(url.searchParams.get("resource")).toBe("https://api.copal.uk/mcp");
	});

	it("is on the code exchange", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ access_token: "at", expires_in: 3600 })));
		await exchangeCode(
			f,
			asTrustedUrl("https://auth.copal.uk/oauth2/token"),
			"cid",
			"code",
			"verifier",
		);
		const body = new URLSearchParams(f.mock.calls[0]![1]!.body as string);
		expect(body.get("resource")).toBe("https://api.copal.uk/mcp");
	});

	it("is on the refresh", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ access_token: "at2", expires_in: 3600 })));
		await refresh(f, asTrustedUrl("https://auth.copal.uk/oauth2/token"), "cid", "rt");
		const body = new URLSearchParams(f.mock.calls[0]![1]!.body as string);
		expect(body.get("resource")).toBe("https://api.copal.uk/mcp");
	});
});
