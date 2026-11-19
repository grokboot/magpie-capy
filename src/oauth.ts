import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { FetchLike } from "./http.ts";

export interface OAuthSettings {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  audience?: string;
  clientSecret?: string;
}

export type OAuthConfig =
  | { kind: "absent" }
  | { kind: "invalid"; error: string }
  | { kind: "configured"; settings: OAuthSettings };

export interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface OAuthSuccess {
  type: "success";
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

export interface OAuthFailure {
  type: "failed";
  error: string;
}

export interface OAuthStart {
  url: string;
  instructions: string;
  method: "auto";
  callback(
    code?: string,
    context?: { signal?: AbortSignal },
  ): Promise<OAuthSuccess | OAuthFailure>;
}

export interface OAuthRuntime {
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  callbackTimeoutMs?: number;
}

export interface OAuthAuthState {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MAX_JSON_BYTES = 64 * 1024;

export function readOAuthConfig(env: Record<string, string | undefined>): OAuthConfig {
  const issuer = env.CAPY_OAUTH_ISSUER?.trim() ?? "";
  const clientId = env.CAPY_OAUTH_CLIENT_ID?.trim() ?? "";
  const redirectUri = env.CAPY_OAUTH_REDIRECT_URI?.trim() ?? "";
  if (!issuer && !clientId && !redirectUri) return { kind: "absent" };

  const missing: string[] = [];
  if (!issuer) missing.push("CAPY_OAUTH_ISSUER");
  if (!clientId) missing.push("CAPY_OAUTH_CLIENT_ID");
  if (!redirectUri) missing.push("CAPY_OAUTH_REDIRECT_URI");
  if (missing.length > 0) {
    return {
      kind: "invalid",
      error: `浏览器登录未配置完整，缺少 ${missing.join("、")}。这只是公开 OAuth/OIDC 配置，不是 Capy 官方第三方 client 登记。`,
    };
  }

  let issuerUrl: URL;
  let redirect: URL;
  try {
    issuerUrl = new URL(issuer);
    redirect = new URL(redirectUri);
  } catch {
    return { kind: "invalid", error: "CAPY_OAUTH_ISSUER 或 CAPY_OAUTH_REDIRECT_URI 不是有效 URL。" };
  }
  if (issuerUrl.protocol !== "https:") {
    return { kind: "invalid", error: "CAPY_OAUTH_ISSUER 必须是 https URL。" };
  }
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)
  ) {
    return {
      kind: "invalid",
      error: "CAPY_OAUTH_REDIRECT_URI 必须是本机 http://127.0.0.1 或 http://localhost 回调地址。",
    };
  }

  const scopes = env.CAPY_OAUTH_SCOPES?.trim() || "openid profile email";
  const audience = env.CAPY_OAUTH_AUDIENCE?.trim();
  const clientSecret = env.CAPY_OAUTH_CLIENT_SECRET?.trim();
  return {
    kind: "configured",
    settings: {
      issuer: issuerUrl.toString().replace(/\/$/, ""),
      clientId,
      redirectUri: redirect.toString(),
      scopes,
      ...(audience ? { audience } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    },
  };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > MAX_JSON_BYTES) throw new Error("OAuth 响应过大。");
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("OAuth 响应不是 JSON 对象。");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OAuth")) throw error;
    throw new Error("OAuth 响应不是有效 JSON。");
  }
}

function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  return fetchImpl(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  });
}

function requireHttpsEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`OAuth discovery 缺少 ${label}。`);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`OAuth discovery 的 ${label} 不是 https。`);
  return url.toString();
}

export async function discoverOAuth(
  settings: OAuthSettings,
  runtime: OAuthRuntime = {},
  signal?: AbortSignal,
): Promise<Discovery> {
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const timeoutMs = runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${settings.issuer}/.well-known/openid-configuration`;
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    { method: "GET", headers: { accept: "application/json" }, redirect: "follow", cache: "no-store" },
    timeoutMs,
    signal,
  );
  if (!response.ok) throw new Error(`OAuth discovery 返回 HTTP ${response.status}。`);
  const body = await boundedJson(response);
  return {
    authorizationEndpoint: requireHttpsEndpoint(body.authorization_endpoint, "authorization_endpoint"),
    tokenEndpoint: requireHttpsEndpoint(body.token_endpoint, "token_endpoint"),
  };
}

interface Loopback {
  server: Server;
  wait(signal?: AbortSignal): Promise<string>;
  close(): void;
}

async function startLoopback(
  redirectUri: string,
  expectedState: string,
  timeoutMs: number,
): Promise<Loopback> {
  const target = new URL(redirectUri);
  const host = target.hostname === "[::1]" ? "::1" : target.hostname;
  const port = target.port ? Number(target.port) : 80;
  let finish!: (error: Error | null, code?: string) => void;
  let settled = false;
  const outcome = new Promise<string>((resolve, reject) => {
    finish = (error, code) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(code ?? "");
    };
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (requestUrl.pathname !== target.pathname) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const error = requestUrl.searchParams.get("error");
    const description = requestUrl.searchParams.get("error_description");
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    let status = 200;
    let text = "Capy 登录回调已收到，可以关闭此页面。";
    if (error) {
      status = 400;
      text = `OAuth 返回错误：${error}${description ? ` (${description.slice(0, 200)})` : ""}`;
      finish(new Error(text));
    } else if (!code) {
      status = 400;
      text = "OAuth 回调缺少 code。";
      finish(new Error(text));
    } else if (state !== expectedState) {
      status = 400;
      text = "OAuth state 不匹配，已拒绝这次回调。";
      finish(new Error(text));
    } else {
      finish(null, code);
    }
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
    response.end(text);
  });

  server.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      (server as { unref?: () => void }).unref?.();
      resolve();
    });
  });

  const timer = setTimeout(() => finish(new Error("OAuth 浏览器登录超时。")), timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    server,
    wait(signal) {
      const onAbort = () => finish(new Error("OAuth 浏览器登录已取消。"));
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      return outcome.finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      });
    },
    close() {
      clearTimeout(timer);
      server.close();
    },
  };
}

function oauthError(body: Record<string, unknown>): string {
  if (typeof body.error !== "string") return "OAuth 端点返回了失败。";
  const description = typeof body.error_description === "string"
    ? `: ${body.error_description.slice(0, 300)}`
    : "";
  return `OAuth 端点返回 ${body.error.slice(0, 100)}${description}`;
}

function successFromToken(body: Record<string, unknown>, now: number): OAuthSuccess {
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("OAuth token 响应缺少 access_token。");
  }
  if (body.access_token.length > 16_384) throw new Error("OAuth access_token 过长。");
  const refresh = typeof body.refresh_token === "string" && body.refresh_token.length > 0
    ? body.refresh_token
    : undefined;
  const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
    ? body.expires_in
    : undefined;
  return {
    type: "success",
    access: body.access_token,
    ...(refresh ? { refresh } : {}),
    ...(expiresIn !== undefined ? { expires: now + expiresIn * 1000 } : {}),
  };
}

async function exchangeCode(
  settings: OAuthSettings,
  discovery: Discovery,
  code: string,
  verifier: string,
  runtime: OAuthRuntime,
  signal?: AbortSignal,
): Promise<OAuthSuccess> {
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: settings.redirectUri,
    client_id: settings.clientId,
    code_verifier: verifier,
  });
  if (settings.clientSecret) form.set("client_secret", settings.clientSecret);
  const response = await fetchWithTimeout(
    fetchImpl,
    discovery.tokenEndpoint,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      redirect: "follow",
      cache: "no-store",
    },
    runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal,
  );
  const body = await boundedJson(response);
  if (!response.ok) throw new Error(oauthError(body));
  return successFromToken(body, runtime.now?.() ?? Date.now());
}

export function createBrowserOAuthMethod(
  settings: OAuthSettings,
  runtime: OAuthRuntime = {},
): { type: "oauth"; label: string; authorize: (inputs?: unknown, context?: { signal?: AbortSignal }) => Promise<OAuthStart> } {
  return {
    type: "oauth",
    label: "浏览器 OAuth/OIDC 登录（需自备公开 client 配置；非 Capy 官方委托）",
    async authorize(_inputs, context = {}) {
      const discovery = await discoverOAuth(settings, runtime, context.signal);
      const { verifier, challenge } = createPkce();
      const state = base64url(randomBytes(24));
      const loopback = await startLoopback(
        settings.redirectUri,
        state,
        runtime.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
      );
      const url = new URL(discovery.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", settings.clientId);
      url.searchParams.set("redirect_uri", settings.redirectUri);
      url.searchParams.set("scope", settings.scopes);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (settings.audience) url.searchParams.set("audience", settings.audience);
      if (context.signal) {
        if (context.signal.aborted) loopback.close();
        else context.signal.addEventListener("abort", () => loopback.close(), { once: true });
      }

      return {
        url: url.toString(),
        instructions:
          "在浏览器完成登录。回调只发送到本机回环地址；不是 Capy 官方第三方 client，audience 与 /api/v1 接受性需由配置方确认。",
        method: "auto",
        async callback(_receivedCode, callbackContext = {}) {
          try {
            const code = await loopback.wait(callbackContext.signal);
            if (!code) return { type: "failed", error: "OAuth 回调缺少 code。" };
            return await exchangeCode(
              settings,
              discovery,
              code,
              verifier,
              runtime,
              callbackContext.signal ?? context.signal,
            );
          } catch (error) {
            return {
              type: "failed",
              error: error instanceof Error ? error.message.slice(0, 500) : "OAuth 登录失败。",
            };
          } finally {
            loopback.close();
          }
        },
      };
    },
  };
}

export async function refreshOAuth(
  settings: OAuthSettings,
  auth: OAuthAuthState,
  runtime: OAuthRuntime = {},
): Promise<Partial<OAuthSuccess>> {
  if (typeof auth.refresh !== "string" || auth.refresh.length === 0) {
    throw new Error("没有可用的 OAuth refresh token。");
  }
  const discovery = await discoverOAuth(settings, runtime);
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refresh,
    client_id: settings.clientId,
  });
  if (settings.clientSecret) form.set("client_secret", settings.clientSecret);
  const response = await fetchWithTimeout(
    fetchImpl,
    discovery.tokenEndpoint,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      redirect: "follow",
      cache: "no-store",
    },
    runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const body = await boundedJson(response);
  if (!response.ok) throw new Error(oauthError(body));
  const next = successFromToken(body, runtime.now?.() ?? Date.now());
  return {
    access: next.access,
    ...(next.refresh ? { refresh: next.refresh } : {}),
    ...(next.expires !== undefined ? { expires: next.expires } : {}),
  };
}
