import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CapyTools } from "../index.ts";
import { createCapyAuth, createCapyAuthHooks } from "../src/auth.ts";
import { TEST_KEY, jsonResponse, makeFetch } from "./helpers.ts";
import { createCapyToolsPlugin } from "../src/tools.ts";

const HOST_KEY = "capy_test_SYNTHETIC_HOST_KEY_123456";
const project = { id: "project_alpha", name: "Alpha" };

function fixture(fetchImpl = makeFetch(() => jsonResponse({ items: [project] })).fetchImpl, env = {}) {
  const auth = createCapyAuth({ fetchImpl, env });
  return { auth, hooks: auth.hooks };
}

function apiAuth(key = HOST_KEY) {
  return Promise.resolve({ type: "api", key });
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

  test("declares a real API-key method and a zero-model auth namespace", async () => {
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
    expect(Object.keys(hooks.tool)).toHaveLength(10);

    const usage = await hooks.auth.usage(async () => apiAuth());
    expect(usage.plan).toBe("Capy");
  });

  test("loader remembers the host key without verifying it", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const { auth, hooks } = fixture(stub.fetchImpl);
    await hooks.auth.loader(async () => apiAuth());
    expect(auth.hostApiKey()).toBe(HOST_KEY);
    expect(auth.hostAuthState().verified).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  test("provider.models verifies with a read-only project list and caches the key", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const { auth, hooks } = fixture(stub.fetchImpl);
    const models = {};
    const out = await hooks.provider.models({ models }, { auth: await apiAuth() });

    expect(out).toBe(models);
    expect(auth.hostApiKey()).toBe(HOST_KEY);
    expect(auth.hostAuthState()).toMatchObject({ verified: true, projectCount: 1, error: null });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/projects");
    expect(stub.calls[0]?.init.method).toBe("GET");
    expect(stub.calls[0]?.url.toString()).not.toContain(HOST_KEY);
  });

  test("usage reports the source that tools actually use and never echoes a key", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const { hooks } = fixture(stub.fetchImpl, { CAPY_API_KEY: TEST_KEY });
    await hooks.provider.models({ models: {} }, { auth: await apiAuth() });
    const usage = await hooks.auth.usage(async () => apiAuth());

    expect(usage.user).toContain("环境变量 CAPY_API_KEY");
    expect(usage.user).toContain("Magpie 登录的 Key 不用于工具");
    expect(usage.user).toContain("仅清除 Magpie 登录不会停用 CAPY_API_KEY");
    expect(usage.user).toContain("不会撤销 Capy 服务端的 Key");
    expect(usage.user).toContain("已验证");
    expect(JSON.stringify(usage)).not.toContain(TEST_KEY);
    expect(JSON.stringify(usage)).not.toContain(HOST_KEY);
  });

  test("malformed env key is surfaced as a configuration error, not a verified status", async () => {
    const { hooks } = fixture(undefined, { CAPY_API_KEY: "bad key" });
    const usage = await hooks.auth.usage(async () => apiAuth());
    expect(usage.user).toContain("环境变量配置错误");
    expect(usage.error).toContain("CAPY_API_KEY 格式无效");
  });

  test("verification caches are per hook instance", async () => {
    const first = fixture(makeFetch(() => jsonResponse({ items: [project] })).fetchImpl);
    await first.hooks.auth.usage(async () => apiAuth());

    const failed = fixture(
      makeFetch(() => {
        throw new Error(`network with ${HOST_KEY}`);
      }).fetchImpl,
    );
    const unverified = await failed.hooks.auth.usage(async () => apiAuth());
    expect(unverified.user).toContain("连接未验证");
    expect(unverified.error).toContain("无法验证");
    expect(JSON.stringify(unverified)).not.toContain(HOST_KEY);
  });

  test("a stale success cannot overwrite a newer key", async () => {
    const a = deferred();
    const b = deferred();
    let call = 0;
    const auth = createCapyAuth({
      fetchImpl: async () => (call++ === 0 ? a.promise : b.promise),
    });

    const pendingA = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_A") });
    const pendingB = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_B") });
    b.resolve(jsonResponse({ items: [] }));
    await pendingB;
    expect(auth.hostApiKey()).toBe("capy_test_B");

    a.resolve(jsonResponse({ items: [project] }));
    await pendingA;
    expect(auth.hostApiKey()).toBe("capy_test_B");
    expect(auth.hostAuthState().verified).toBe(true);
  });

  test("a stale 401 cannot wipe a newer key", async () => {
    const a = deferred();
    const b = deferred();
    let call = 0;
    const auth = createCapyAuth({
      fetchImpl: async () => (call++ === 0 ? a.promise : b.promise),
    });

    const pendingA = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_A") });
    const pendingB = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_B") });
    b.resolve(jsonResponse({ items: [] }));
    await pendingB;

    a.resolve(jsonResponse({ _tag: "capy/Unauthorized" }, 401));
    await pendingA;
    expect(auth.hostApiKey()).toBe("capy_test_B");
    expect(auth.hostAuthState().verified).toBe(true);
  });

  test("a stale usage 401 does not mark the newer sign-in expired", async () => {
    const a = deferred();
    const b = deferred();
    let call = 0;
    const auth = createCapyAuth({
      fetchImpl: async () => (call++ === 0 ? a.promise : b.promise),
    });
    const pendingA = auth.hooks.auth.usage(async () => apiAuth("capy_test_A"));
    const pendingB = auth.hooks.auth.usage(async () => apiAuth("capy_test_B"));
    b.resolve(jsonResponse({ items: [] }));
    await pendingB;
    a.resolve(jsonResponse({ _tag: "capy/Unauthorized" }, 401));
    const stale = await pendingA;
    expect(stale.signIn).toBeUndefined();
    expect(stale.error).toContain("验证结果已过期");
    expect(auth.hostApiKey()).toBe("capy_test_B");
  });

  test("sign-out invalidates an in-flight verification", async () => {
    const pending = deferred();
    const auth = createCapyAuth({ fetchImpl: async () => pending.promise });
    const request = auth.hooks.provider.models({ models: {} }, { auth: await apiAuth("capy_test_C") });
    await auth.hooks.provider.models({ models: {} }, {});
    expect(auth.hostApiKey()).toBeNull();

    pending.resolve(jsonResponse({ items: [project] }));
    await request;
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostAuthState().verified).toBe(false);
  });

  test("multiple host accounts fail closed rather than choosing one", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
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

  test("401 clears tool use and marks sign-in expired without deleting host auth", async () => {
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
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const { auth, hooks } = fixture(stub.fetchImpl);
    await hooks.provider.models({ models: {} }, { auth: await apiAuth("capy bad key") });
    expect(auth.hostApiKey()).toBeNull();
    const usage = await hooks.auth.usage(async () => apiAuth("capy bad key"));
    expect(usage.user).toBe("未配置");
    expect(usage.error).toContain("格式无效");
  });

  test("sign-out clears the host key on the next provider refresh", async () => {
    const { auth, hooks } = fixture();
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
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const method = apiMethod(auth);

    // Host `keyAsked` contract: api + non-empty prompts + authorize => the host
    // asks only these prompts and saves only what authorize returns as success.
    expect(method.type).toBe("api");
    expect(method.prompts).toHaveLength(1);
    expect(method.prompts?.[0]).toMatchObject({ type: "password", key: "key" });
    expect(typeof method.authorize).toBe("function");
    expect(method.prompts?.[0]?.validate?.("capy bad key")).toContain("空格");
    expect(method.prompts?.[0]?.validate?.(HOST_KEY)).toBeNull();

    const result = await method.authorize?.({ key: HOST_KEY });
    expect(result).toEqual({ type: "success", key: HOST_KEY });
    // Validation ran, but the host has not handed the key back yet.
    expect(auth.hostApiKey()).toBeNull();
    expect(auth.hostAuthState().verified).toBe(false);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url.origin).toBe("https://api.capy.ai");
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/projects");
    expect(stub.calls[0]?.init.method).toBe("GET");
    expect(stub.calls.some((call) => call.init.method !== "GET")).toBe(false);

    await auth.hooks.auth.loader(async () => apiAuth());
    const usage = await auth.hooks.auth.usage(async () => apiAuth());
    expect(usage.user).toContain("只读连接已验证 · 1 个项目");
    expect(usage.error).toBeUndefined();
    expect(stub.calls).toHaveLength(1);
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
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const controller = new AbortController();
    controller.abort();

    const result = await apiMethod(auth).authorize?.({ key: HOST_KEY }, { signal: controller.signal });
    expect(result?.type).toBe("failed");
    expect(stub.calls).toHaveLength(0);
    expect(auth.hostApiKey()).toBeNull();
  });

  test("a malformed key fails offline instead of reaching Capy", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const result = await apiMethod(auth).authorize?.({ key: "capy bad key" });

    expect(result?.type).toBe("failed");
    expect(stub.calls).toHaveLength(0);
    expect(result?.error).not.toContain("capy bad key");
    expect(auth.hostApiKey()).toBeNull();
  });

  test("a persisted key re-verifies on reload with one bounded read-only GET", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const reloaded = createCapyAuth({ fetchImpl: stub.fetchImpl });
    await reloaded.hooks.auth.loader(async () => apiAuth());
    const usage = await reloaded.hooks.auth.usage(async () => apiAuth());

    expect(usage.user).toContain("工具使用 Magpie 登录");
    expect(usage.user).toContain("只读连接已验证 · 1 个项目");
    expect(usage.user).toContain("不会撤销 Capy 服务端的 Key");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.init.method).toBe("GET");
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/projects");
    expect(JSON.stringify(usage)).not.toContain(HOST_KEY);
  });

  test("a 403 read denial is explained as a role/project limit, not escalated", async () => {
    const stub = makeFetch(() => jsonResponse({ _tag: "capy/Forbidden" }, 403));
    const auth = createCapyAuth({ fetchImpl: stub.fetchImpl });
    const usage = await auth.hooks.auth.usage(async () => apiAuth());

    expect(usage.user).toContain("连接未验证");
    expect(usage.error).toContain("403");
    expect(usage.error).toContain("不会为此提权");
    expect(usage.signIn).toBeUndefined();
    expect(JSON.stringify(usage)).not.toContain(HOST_KEY);
  });

  test("local sign-out makes tool calls fail closed with no cached key and no network", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
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
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
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
