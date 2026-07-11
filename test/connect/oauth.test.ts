import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  discover,
  exchangeCode,
  refresh,
  registerClient,
  REDIRECT_URI,
} from "../../src/connect/oauth";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("buildAuthorizeUrl", () => {
  it("builds a PKCE authorize URL with all required params", () => {
    const url = new URL(
      buildAuthorizeUrl(
        "https://api.copal.uk/authorize",
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
    expect(url.searchParams.get("scope")).toBe("vault.read vault.write");
    expect(url.searchParams.get("state")).toBe("st8");
  });
});

describe("discover", () => {
  it("returns the endpoints", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        registration_endpoint: "https://api.copal.uk/register",
        authorization_endpoint: "https://api.copal.uk/authorize",
        token_endpoint: "https://api.copal.uk/token",
      }),
    );
    const d = await discover(f);
    expect(d.token_endpoint).toBe("https://api.copal.uk/token");
  });
});

describe("registerClient", () => {
  it("posts a public loopback-free client registration and returns the id", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ client_id: "abc123" }, 201));
    const reg = await registerClient(f, "https://api.copal.uk/register");
    expect(reg.client_id).toBe("abc123");
    const [, init] = f.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as {
      redirect_uris: string[];
      token_endpoint_auth_method: string;
    };
    expect(body.redirect_uris).toEqual([REDIRECT_URI]);
    expect(body.token_endpoint_auth_method).toBe("none");
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
    const t = await exchangeCode(f, "https://api.copal.uk/token", "cid", "code123", "verifier123");
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
    await expect(exchangeCode(f, "https://api.copal.uk/token", "cid", "c", "v")).rejects.toThrow();
  });
});

describe("refresh", () => {
  it("posts the refresh_token grant", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ access_token: "at2" }));
    const t = await refresh(f, "https://api.copal.uk/token", "cid", "rt");
    expect(t.access_token).toBe("at2");
    const [, init] = f.mock.calls[0]!;
    const body = new URLSearchParams(init!.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt");
  });
});
