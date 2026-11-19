import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  createBrowserOAuthMethod,
  createPkce,
  readOAuthConfig,
  refreshOAuth,
} from "../src/oauth.ts";
import { jsonResponse, makeFetch } from "./helpers.ts";
import { createCapyAuth } from "../src/auth.ts";

const settings = {
  issuer: "https://auth.example.test",
  clientId: "magpie-capy-test",
  redirectUri: "http://127.0.0.1:1/callback",
  scopes: "openid profile email",
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function discovery(authorization = "https://auth.example.test/authorize") {
  return {
    issuer: settings.issuer,
    authorization_endpoint: authorization,
    token_endpoint: "https://auth.example.test/token",
  };
}

describe("browser OAuth configuration", () => {
  test("absence is a feature gate, not an implicit Capy client", () => {
    expect(readOAuthConfig({})).toEqual({ kind: "absent" });
  });

  test("partial configuration reports every missing public setting", () => {
    const config = readOAuthConfig({ CAPY_OAUTH_ISSUER: settings.issuer });
    expect(config.kind).toBe("invalid");
    if (config.kind === "invalid") {
      expect(config.error).toContain("CAPY_OAUTH_CLIENT_ID");
      expect(config.error).toContain("CAPY_OAUTH_REDIRECT_URI");
    }
  });

  test("requires https issuer and a loopback http redirect", () => {
    expect(
      readOAuthConfig({
        CAPY_OAUTH_ISSUER: "http://auth.example.test",
        CAPY_OAUTH_CLIENT_ID: "client",
        CAPY_OAUTH_REDIRECT_URI: "http://127.0.0.1:1234/callback",
      }).kind,
    ).toBe("invalid");
    expect(
      readOAuthConfig({
        CAPY_OAUTH_ISSUER: settings.issuer,
        CAPY_OAUTH_CLIENT_ID: "client",
        CAPY_OAUTH_REDIRECT_URI: "https://app.example.test/callback",
      }).kind,
    ).toBe("invalid");
    const configured = readOAuthConfig({
      CAPY_OAUTH_ISSUER: settings.issuer,
      CAPY_OAUTH_CLIENT_ID: "client",
      CAPY_OAUTH_REDIRECT_URI: "http://127.0.0.1:1234/callback",
      CAPY_OAUTH_AUDIENCE: "capy",
    });
    expect(configured.kind).toBe("configured");
    if (configured.kind === "configured") {
      expect(configured.settings.scopes).toBe("openid profile email");
      expect(configured.settings.audience).toBe("capy");
    }
  });

  test("PKCE is S256 with a 43+ character verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).not.toBe(challenge);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("browser OAuth flow", () => {
  test("returns an S256 URL and exchanges the loopback code", async () => {
    const port = await freePort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const stub = makeFetch((url) => {
      if (url.pathname === "/.well-known/openid-configuration") return jsonResponse(discovery());
      if (url.pathname === "/token") {
        return jsonResponse({
          access_token: "oauth_access_token",
          refresh_token: "oauth_refresh_token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      return jsonResponse({ _tag: "unknown" }, 404);
    });
    const method = createBrowserOAuthMethod(
      { ...settings, redirectUri },
      { fetchImpl: stub.fetchImpl, now: () => 1_000_000, callbackTimeoutMs: 5_000 },
    );
    const start = await method.authorize();
    const authorization = new URL(start.url);
    expect(authorization.origin).toBe("https://auth.example.test");
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("client_id")).toBe(settings.clientId);
    expect(authorization.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();

    const pending = start.callback(undefined, {});
    const callbackResponse = await fetch(
      `${redirectUri}?code=auth_code&state=${encodeURIComponent(state!)}`,
    );
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain("登录回调已收到");

    const result = await pending;
    expect(result).toMatchObject({
      type: "success",
      access: "oauth_access_token",
      refresh: "oauth_refresh_token",
      expires: 1_000_000 + 3_600_000,
    });

    const tokenCall = stub.calls.find((call) => call.url.pathname === "/token")!;
    const body = new URLSearchParams(String(tokenCall.init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth_code");
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("client_id")).toBe(settings.clientId);
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("client_secret")).toBeNull();
  });

  test("rejects a state mismatch instead of exchanging the code", async () => {
    const port = await freePort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const stub = makeFetch((url) => {
      if (url.pathname === "/.well-known/openid-configuration") return jsonResponse(discovery());
      return jsonResponse({ access_token: "should_not_be_used" });
    });
    const method = createBrowserOAuthMethod(
      { ...settings, redirectUri },
      { fetchImpl: stub.fetchImpl, callbackTimeoutMs: 5_000 },
    );
    const start = await method.authorize();
    const pending = start.callback(undefined, {});
    const response = await fetch(`${redirectUri}?code=auth_code&state=wrong`);
    expect(response.status).toBe(400);
    const result = await pending;
    expect(result.type).toBe("failed");
    if (result.type === "failed") expect(result.error).toContain("state");
    expect(stub.calls.some((call) => call.url.pathname === "/token")).toBe(false);
  });

  test("cancelling the local wait stops the callback", async () => {
    const port = await freePort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const stub = makeFetch((url) => {
      if (url.pathname === "/.well-known/openid-configuration") return jsonResponse(discovery());
      return jsonResponse({ access_token: "unused" });
    });
    const method = createBrowserOAuthMethod(
      { ...settings, redirectUri },
      { fetchImpl: stub.fetchImpl, callbackTimeoutMs: 60_000 },
    );
    const start = await method.authorize();
    const controller = new AbortController();
    const pending = start.callback(undefined, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.type).toBe("failed");
    if (result.type === "failed") expect(result.error).toContain("取消");
  });
});

describe("OAuth refresh", () => {
  test("uses refresh_token grant and returns only rotated fields", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname === "/.well-known/openid-configuration") return jsonResponse(discovery());
      if (url.pathname === "/token") {
        return jsonResponse({
          access_token: "new_access",
          refresh_token: "new_refresh",
          expires_in: 60,
        });
      }
      return jsonResponse({}, 404);
    });
    const next = await refreshOAuth(
      settings,
      { type: "oauth", access: "old_access", refresh: "old_refresh" },
      { fetchImpl: stub.fetchImpl, now: () => 5_000 },
    );
    expect(next).toEqual({ access: "new_access", refresh: "new_refresh", expires: 65_000 });
    const tokenCall = stub.calls.find((call) => call.url.pathname === "/token")!;
    const body = new URLSearchParams(String(tokenCall.init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old_refresh");
  });

  test("throws a safe error when no refresh token exists", async () => {
    await expect(
      refreshOAuth(settings, { type: "oauth", access: "old_access" }),
    ).rejects.toThrow(/refresh token/);
  });
});

describe("OAuth auth hook registration", () => {
  test("is absent by default and appears with refresh only when configured", () => {
    const absent = createCapyAuth({ env: {} });
    expect(absent.hooks.auth.methods).toHaveLength(1);
    expect((absent.hooks.auth as { refresh?: unknown }).refresh).toBeUndefined();

    const configured = createCapyAuth({
      env: {
        CAPY_OAUTH_ISSUER: settings.issuer,
        CAPY_OAUTH_CLIENT_ID: settings.clientId,
        CAPY_OAUTH_REDIRECT_URI: "http://127.0.0.1:53682/callback",
      },
    });
    expect(configured.hooks.auth.methods).toHaveLength(2);
    expect(configured.hooks.auth.methods[1]).toMatchObject({ type: "oauth" });
    expect((configured.hooks.auth.methods[1]!.label as string)).toContain("非 Capy 官方");
    expect(typeof (configured.hooks.auth as { refresh?: unknown }).refresh).toBe("function");
  });

  test("partial configuration still surfaces the missing variables", () => {
    const auth = createCapyAuth({ env: { CAPY_OAUTH_ISSUER: settings.issuer } });
    expect(auth.hooks.auth.methods).toHaveLength(2);
    expect(auth.hooks.auth.methods[1]).toMatchObject({ type: "oauth" });
  });
});
