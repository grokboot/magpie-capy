import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CapyTools } from "../index.ts";
import { createCapyAuth } from "../src/auth.ts";
import { TEST_KEY, jsonResponse, makeFetch, type FetchStub } from "./helpers.ts";
import { createCapyToolsPlugin } from "../src/tools.ts";
import type { FetchLike } from "../src/http.ts";

const HOST_KEY = "capy_test_SYNTHETIC_HOST_KEY_123456";
const project = { id: "project_alpha", name: "Alpha" };
const model = {
  id: "capy-coder",
  name: "Capy Coder",
  billing: "Capy API",
  route: "capy",
  reasoningModes: ["low", "high"],
  fast: true,
  pro: false,
  ultrafast: false,
};
const catalog = {
  items: [model],
  default: { modelId: model.id, source: "personal", skipped: [] },
};
const balance = {
  currency: "USD",
  remainingDollars: 12.5,
  unlimited: false,
  periodStart: "2026-11-01T00:00:00.000Z",
  periodEnd: "2026-12-01T00:00:00.000Z",
};
const report = {
  from: balance.periodStart,
  to: balance.periodEnd,
  totals: {
    llmDollars: 3.5,
    imageDollars: 0,
    vmDollars: 0,
    totalDollars: 3.5,
    standaloneTokenFeeDollars: 0,
    billedDollars: 3.5,
  },
  tokens: {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  members: [],
  models: [],
  images: [],
};

function defaultFetch(): FetchStub {
  return makeFetch((url) => {
    if (url.pathname === "/api/v1/projects") return jsonResponse({ items: [project] });
    if (url.pathname === "/api/v1/models") return jsonResponse(catalog);
    if (url.pathname === "/api/v1/usage/balance") return jsonResponse(balance);
    if (url.pathname === "/api/v1/usage") return jsonResponse(report);
    return jsonResponse({ _tag: "capy/InvalidRequest" }, 400);
  });
}

function fixture(fetchImpl: FetchLike = defaultFetch().fetchImpl, env = {}) {
  const auth = createCapyAuth({ fetchImpl, env });
  return { auth, hooks: auth.hooks };
}

function apiAuth(key = HOST_KEY) {
  return Promise.resolve({ type: "api", key });
}

function oauthAuth(access = "oauth_access", refresh = "oauth_refresh") {
  return Promise.resolve({ type: "oauth", access, refresh, expires: Date.now() + 60_000 });
}

function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Capy auth hooks", () => {
  test("the entry combines tools with the auth/provider hooks", async () => {
    const hooks = await CapyTools();
    expect(hooks.tool.list_projects).toBeDefined();
    expect(hooks.auth.provider).toBe("capy");
    expect(hooks.provider.id).toBe("capy");
    expect(hooks.config).toBeDefined();
  });

  test("declares a real API-key method and a dynamic provider namespace", async () => {
    const { hooks } = fixture();
    expect(hooks.auth.provider).toBe("capy");
    const method = hooks.auth.methods[0]!;
    expect(method).toMatchObject({ type: "api" });
    expect(method.label).toContain("Capy");
    expect(method.label).toContain("API Key");

    const cfg: { provider?: Record<string, unknown> } = {};
    await hooks.config(cfg);
    expect(cfg.provider?.capy).toMatchObject({ name: "Capy", models: {} });
  });

  test("the real plugin entry displays exactly Capy in the config provider bridge", async () => {
    const hooks = await CapyTools();
    const cfg: { provider?: Record<string, unknown> } = {};
    await hooks.config(cfg);
    const provider = cfg.provider?.capy as { name: string; api: string; models: Record<string, unknown> };
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string;
      magpie: { name: string };
    };

    expect(provider.name).toBe("Capy");
    expect(provider.name).toBe(pkg.magpie.name);
    expect(provider.name).not.toMatch(/[（(]/);
    expect(provider.api).toBe("https://api.capy.ai");
    expect(provider.models).toEqual({});
    expect(hooks.auth.provider).toBe("capy");
    expect(pkg.name).toBe("magpie-capy");
    expect(Object.keys(hooks.tool)).toHaveLength(15);

    const usage = await hooks.auth.usage(async () => apiAuth());
    expect(usage.plan).toBe("Capy");
  });

  test("loader remembers the host key without verifying it", async () => {
    const stub = defaultFetch();
    const { auth, hooks } = fixture(stub.fetchImpl);
    await hooks.auth.loader(async () => apiAuth());
    expect(auth.hostApiKey()).toBe(HOST_KEY);
    expect(auth.hostAuthState().verified).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  test("provider.models reads the documented model catalog and maps only documented fields", async () => {
    const stub = defaultFetch();
    const { auth, hooks } = fixture(stub.fetchImpl);
    const models = {};
    const out = await hooks.provider.models({ models }, { auth: await apiAuth() }) as Record<
      string,
      Record<string, unknown>
    >;

    expect(out["capy-coder"]).toMatchObject({
      id: "capy-coder",
      name: "Capy Coder",
      reasoning: true,
      billing: "Capy API",
      route: "capy",
    });
    expect(out["capy-coder"]?.variants).toEqual({ low: {}, high: {} });
    expect(out["capy-coder"]?.limit).toBeUndefined();
    expect(auth.hostApiKey()).toBe(HOST_KEY);
    expect(auth.hostAuthState()).toMatchObject({ verified: true, error: null });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/models");
    expect(stub.calls[0]?.init.method).toBe("GET");
    expect(stub.calls[0]?.url.toString()).not.toContain(HOST_KEY);
  });

  test("an OAuth host credential uses the same model catalog and bearer", async () => {
    const stub = defaultFetch();
    const { auth, hooks } = fixture(stub.fetchImpl);
    const out = await hooks.provider.models({ models: {} }, { auth: await oauthAuth() }) as Record<
      string,
      unknown
    >;
    expect(out["capy-coder"]).toBeDefined();
    expect(auth.hostAuthState().authType).toBe("oauth");
    expect(auth.hostApiKey()).toBe("oauth_access");
  });

  test("usage reads the real balance and period report; it never invents a zero", async () => {
    const stub = defaultFetch();
    const { hooks } = fixture(stub.fetchImpl, { CAPY_API_KEY: TEST_KEY });
    await hooks.provider.models({ models: {} }, { auth: await apiAuth() });
    const usage = await hooks.auth.usage(async () => apiAuth());

    expect(usage.user).toContain("环境变量 CAPY_API_KEY");
    expect(usage.user).toContain("Magpie 登录的凭据不用于工具");
    expect(usage.user).toContain("仅清除 Magpie 登录不会停用 CAPY_API_KEY");
    expect(usage.user).toContain("额度已读取");
    expect(usage.balance).toBe("$12.50");
    expect(usage.windows[0]).toMatchObject({
      name: "Capy credits",
      balance: 12.5,
      unit: "USD",
      resetsAt: balance.periodEnd,
    });
    expect(usage.windows[1]?.display).toContain("$3.50 total");
    expect(JSON.stringify(usage)).not.toContain(TEST_KEY);
    expect(JSON.stringify(usage)).not.toContain(HOST_KEY);
  });

  test("an unlimited balance is not rendered as a number", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname === "/api/v1/usage/balance") {
        return jsonResponse({ ...balance, remainingDollars: null, unlimited: true });
      }
      return jsonResponse(report);
    });
    const { hooks } = fixture(stub.fetchImpl);
    const usage = await hooks.auth.usage(async () => apiAuth());
    expect(usage.windows[0]?.display).toBe("Unlimited");
    expect(usage.windows[0]?.balance).toBeUndefined();
    expect(usage.balance).toBeUndefined();
  });

  test("a null non-unlimited balance says no credit balance, not zero", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname === "/api/v1/usage/balance") {
        return jsonResponse({ ...balance, remainingDollars: null, unlimited: false });
      }
      return jsonResponse(report);
    });
    const { hooks } = fixture(stub.fetchImpl);
    const usage = await hooks.auth.usage(async () => apiAuth());
    expect(usage.windows[0]?.display).toBe("No credit balance");
    expect(usage.user).toContain("无信用余额");
  });

  test("a report failure leaves the balance visible and labels period spend unavailable", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname === "/api/v1/usage/balance") return jsonResponse(balance);
      return jsonResponse({ _tag: "capy/UsageUnavailable" }, 503);
    });
    const { hooks } = fixture(stub.fetchImpl);
    const usage = await hooks.auth.usage(async () => apiAuth());
    expect(usage.windows[0]?.balance).toBe(12.5);
    expect(usage.windows[1]?.display).toContain("Unavailable");
    expect(usage.error).toBeUndefined();
  });

  test("malformed env key is surfaced as a configuration error, not a verified status", async () => {
    const { hooks } = fixture(undefined, { CAPY_API_KEY: "bad key" });
    const usage = await hooks.auth.usage(async () => apiAuth());
    expect(usage.user).toContain("环境变量配置错误");
    expect(usage.error).toContain("CAPY_API_KEY 格式无效");
  });

  test("usage verification caches are per hook instance and a network failure is explicit", async () => {
    const first = fixture(defaultFetch().fetchImpl);
    await first.hooks.auth.usage(async () => apiAuth());
    expect((await first.hooks.provider.models({ models: {} }, { auth: await apiAuth() }))["capy-coder"]).toBeDefined();

    const failed = fixture(
      makeFetch(() => {
        throw new Error(`network with ${HOST_KEY}`);
      }).fetchImpl,
    );
    const unverified = await failed.hooks.auth.usage(async () => apiAuth());
    expect(unverified.user).toContain("额度不可用");
    expect(unverified.error).toContain("无法连接");
    expect(unverified.windows).toEqual([]);
    expect(JSON.stringify(unverified)).not.toContain(HOST_KEY);
  });

  test("a stale model success cannot overwrite a newer key", async () => {
    const a = deferred();
    const b = deferred();
    let call = 0;
    const auth = createCapyAuth({
      fetchImpl: async () => (call++ === 0 ? a.promise : b.promise),
    });

    const pendingA = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_A") });
    const pendingB = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_B") });
    b.resolve(jsonResponse(catalog));
    await pendingB;
    expect(auth.hostApiKey()).toBe("capy_test_B");

    a.resolve(jsonResponse(catalog));
    await pendingA;
    expect(auth.hostApiKey()).toBe("capy_test_B");
    expect(auth.hostAuthState().verified).toBe(true);
  });

  test("a stale model 401 cannot wipe a newer key", async () => {
    const a = deferred();
    const b = deferred();
    let call = 0;
    const auth = createCapyAuth({
      fetchImpl: async () => (call++ === 0 ? a.promise : b.promise),
    });

    const pendingA = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_A") });
    const pendingB = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_B") });
    b.resolve(jsonResponse(catalog));
    await pendingB;

    a.resolve(jsonResponse({ _tag: "capy/Unauthorized" }, 401));
    await pendingA;
    expect(auth.hostApiKey()).toBe("capy_test_B");
    expect(auth.hostAuthState().verified).toBe(true);
  });

  test("a stale usage 401 does not mark the newer sign-in expired", async () => {
    const a = deferred();
    const b = deferred();
    const auth = createCapyAuth({
      fetchImpl: async (input, init = {}) => {
        const path = new URL(input.toString()).pathname;
        const bearer = new Headers(init.headers).get("authorization");
        if (path === "/api/v1/usage/balance") {
          return bearer === "Bearer capy_test_A" ? a.promise : b.promise;
        }
        return jsonResponse(report);
      },
    });
    const pendingA = auth.hooks.auth.usage(async () => apiAuth("capy_test_A"));
    const pendingB = auth.hooks.auth.usage(async () => apiAuth("capy_test_B"));
    b.resolve(jsonResponse(balance));
    await pendingB;
    a.resolve(jsonResponse({ _tag: "capy/Unauthorized" }, 401));
    const stale = await pendingA;
    expect(stale.signIn).toBeUndefined();
    expect(stale.error).toContain("验证结果已过期");
    expect(auth.hostApiKey()).toBe("capy_test_B");
  });

  test("sign-out invalidates an in-flight model verification", async () => {
    const pending = deferred();
    const auth = createCapyAuth({ fetchImpl: async () => pending.promise });
    const request = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_C") });
    await auth.hooks.provider.models({ models: {} }, {});
    expect(auth.hostApiKey()).toBeNull();

    pending.resolve(jsonResponse(catalog));
    await request;
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostAuthState().verified).toBe(false);
  });

  test("multiple host accounts fail closed rather than choosing one", async () => {
    const stub = defaultFetch();
    let account = "capy";
    const auth = createCapyAuth({
      fetchImpl: stub.fetchImpl,
      accountKey: () => account,
    });
    await auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_A") });
    account = "capy#B";
    await auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_B") });
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostApiKeyError()).toContain("多个 Capy 宿主账号");
    expect((await auth.hooks.auth.usage(async () => apiAuth("capy_test_B"))).user).toContain("多个宿主账号");
  });

  test("a model 401 clears tool use and marks sign-in expired without deleting host auth", async () => {
    const stub = makeFetch(() => jsonResponse({ _tag: "capy/Unauthorized" }, 401));
    const { auth, hooks } = fixture(stub.fetchImpl);
    try {
      await hooks.provider.models({ models: {} }, { auth: await apiAuth() });
      throw new Error("expected sign-in failure");
    } catch (error) {
      expect((error as Error & { signIn?: string }).signIn).toBe("expired");
      expect((error as Error).message).not.toContain(HOST_KEY);
    }
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostAuthState().verified).toBe(false);
  });

  test("malformed saved key reports format error instead of missing", async () => {
    const stub = defaultFetch();
    const { auth, hooks } = fixture(stub.fetchImpl);
    await hooks.provider.models({ models: {} }, { auth: await apiAuth("capy bad key") });
    expect(auth.hostApiKey()).toBeNull();
    const usage = await hooks.auth.usage(async () => apiAuth("capy bad key"));
    expect(usage.user).toBe("未配置");
    expect(usage.error).toContain("格式无效");
  });

  test("sign-out clears the host key on the next provider refresh", async () => {
    const { auth, hooks } = fixture(defaultFetch().fetchImpl);
    await hooks.provider.models({ models: {} }, { auth: await apiAuth() });
    expect(auth.hostApiKey()).toBe(HOST_KEY);
    await hooks.provider.models({ models: {} }, {});
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostAuthState().verified).toBe(false);
  });
});

interface ApiMethod {
  type: string;
  label: string;
  placeholder?: string;
  prompts?: {
    type: string;
    key: string;
    message: string;
    placeholder?: string;
    validate?: (value: unknown) => string | null;
  }[];
  authorize?: (
    inputs?: Record<string, unknown>,
    ctx?: { signal?: AbortSignal },
  ) => Promise<{ type: string; key?: string; error?: string }>;
}

function apiMethod(auth: ReturnType<typeof createCapyAuth>): ApiMethod {
  return auth.hooks.auth.methods[0] as unknown as ApiMethod;
}

describe("Capy sign-in host contract", () => {
  test("the api method validates with a masked prompt before the host persists anything", async () => {
    const stub = defaultFetch();
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const method = apiMethod(auth);

    expect(method.type).toBe("api");
    expect(method.prompts).toHaveLength(1);
    expect(method.prompts?.[0]).toMatchObject({ type: "password", key: "key" });
    expect(typeof method.authorize).toBe("function");
    expect(method.prompts?.[0]?.validate?.("capy bad key")).toContain("空格");
    expect(method.prompts?.[0]?.validate?.(HOST_KEY)).toBeNull();

    const result = await method.authorize?.({ key: HOST_KEY });
    expect(result).toEqual({ type: "success", key: HOST_KEY });
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostAuthState().verified).toBe(false);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url.origin).toBe("https://api.capy.ai");
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/projects");
    expect(stub.calls[0]?.init.method).toBe("GET");

    await auth.hooks.auth.loader(async () => apiAuth());
    const usage = await auth.hooks.auth.usage(async () => apiAuth());
    expect(usage.user).toContain("额度已读取");
    expect(usage.windows[0]?.balance).toBe(12.5);
    expect(stub.calls.filter((call) => call.url.pathname === "/api/v1/projects")).toHaveLength(1);
  });

  test("a rejected key is reported and never saved or marked connected", async () => {
    const stub = makeFetch(() => jsonResponse({ _tag: "capy/Unauthorized" }, 401));
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const result = await apiMethod(auth).authorize?.({ key: HOST_KEY });

    expect(result?.type).toBe("failed");
    expect(result?.error).toContain("401");
    expect(result?.error).toContain("过期");
    expect(result?.error).toContain("撤销");
    expect(result?.error).toContain("Settings → API");
    expect(result?.error).not.toContain(HOST_KEY);
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostAuthState().verified).toBe(false);

    const usage = await auth.hooks.auth.usage(async () => null);
    expect(usage.user).toBe("未配置");
    expect(JSON.stringify(usage)).not.toContain(HOST_KEY);
  });

  test("cancelling a validation saves nothing and clears its cached result", async () => {
    const pending = deferred();
    const auth = createCapyAuth({ fetchImpl: async () => pending.promise });
    const controller = new AbortController();
    const request = apiMethod(auth).authorize?.({ key: HOST_KEY }, { signal: controller.signal });
    controller.abort();
    pending.resolve(jsonResponse({ items: [project] }));

    const result = await request;
    expect(result?.type).toBe("failed");
    expect(result?.error).toContain("取消");
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostAuthState().verified).toBe(false);
    expect(auth.hostAuthState().checkedAt).toBeNull();
  });

  test("an already-cancelled validation makes no network call", async () => {
    const stub = defaultFetch();
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const controller = new AbortController();
    controller.abort();

    const result = await apiMethod(auth).authorize?.({ key: HOST_KEY }, { signal: controller.signal });
    expect(result?.type).toBe("failed");
    expect(stub.calls).toHaveLength(0);
    expect(auth.hostApiKey()).toBeNull();
  });

  test("a malformed key fails offline instead of reaching Capy", async () => {
    const stub = defaultFetch();
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const result = await apiMethod(auth).authorize?.({ key: "capy bad key" });

    expect(result?.type).toBe("failed");
    expect(stub.calls).toHaveLength(0);
    expect(result?.error).not.toContain("capy bad key");
    expect(auth.hostApiKey()).toBeNull();
  });

  test("a persisted key reads balance on reload without a project call", async () => {
    const stub = defaultFetch();
    const reloaded = createCapyAuth({ fetchImpl: stub.fetchImpl });
    await reloaded.hooks.auth.loader(async () => apiAuth());
    const usage = await reloaded.hooks.auth.usage(async () => apiAuth());

    expect(usage.user).toContain("工具使用 Magpie 登录");
    expect(usage.user).toContain("额度已读取");
    expect(usage.windows[0]?.balance).toBe(12.5);
    expect(stub.calls.map((call) => call.url.pathname).sort()).toEqual([
      "/api/v1/usage",
      "/api/v1/usage/balance",
    ]);
    expect(JSON.stringify(usage)).not.toContain(HOST_KEY);
  });

  test("a 403 balance denial is explained as unknown, not zero, and not an expired sign-in", async () => {
    const stub = makeFetch(() => jsonResponse({ _tag: "capy/Forbidden" }, 403));
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const usage = await auth.hooks.auth.usage(async () => apiAuth());

    expect(usage.user).toContain("额度不可用");
    expect(usage.error).toContain("403");
    expect(usage.error).toContain("不是 0 余额");
    expect(usage.signIn).toBeUndefined();
    expect(JSON.stringify(usage)).not.toContain(HOST_KEY);
  });

  test("local sign-out makes tool calls fail closed with no cached key and no network", async () => {
    const stub = defaultFetch();
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const tools = await createCapyToolsPlugin({
      fetchImpl: stub.fetchImpl,
      hostApiKey: auth.hostApiKey,
      hostApiKeyError: auth.hostApiKeyError,
    })();

    await auth.hooks.provider.models({ models: {} }, { auth: await apiAuth() });
    expect(auth.hostApiKey()).toBe(HOST_KEY);
    const callsWhileSignedIn = stub.calls.length;

    await auth.hooks.auth.loader(async () => null);
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostAuthState().verified).toBe(false);

    await expect(tools.tool.list_projects!.execute({})).rejects.toThrow(/No Capy API key/);
    expect(stub.calls).toHaveLength(callsWhileSignedIn);
    expect((await auth.hooks.auth.usage(async () => null)).user).toBe("未配置");
  });

  test("CAPY_API_KEY still authorizes after local sign-out and is disclosed as the source", async () => {
    const stub = defaultFetch();
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl, env: { CAPY_API_KEY: TEST_KEY } });
    const tools = await createCapyToolsPlugin({
      fetchImpl: stub.fetchImpl,
      env: { CAPY_API_KEY: TEST_KEY },
      hostApiKey: auth.hostApiKey,
      hostApiKeyError: auth.hostApiKeyError,
    })();

    await auth.hooks.auth.loader(async () => null);
    const out = await tools.tool.list_projects!.execute({});
    expect(out).toMatchObject({ items: [project] });

    const usage = await auth.hooks.auth.usage(async () => null);
    expect(usage.user).toContain("工具使用环境变量 CAPY_API_KEY");
    expect(usage.user).toContain("仅清除 Magpie 登录不会停用 CAPY_API_KEY");
    expect(JSON.stringify(usage)).not.toContain(TEST_KEY);
  });
});
