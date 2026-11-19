import { describe, expect, test } from "bun:test";
import { CapyTools } from "../index.ts";
import { createCapyAuth, createCapyAuthHooks } from "../src/auth.ts";
import { TEST_KEY, jsonResponse, makeFetch } from "./helpers.ts";

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
    expect(cfg.provider?.capy).toMatchObject({ name: "Capy（任务工具）", models: {} });
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
    expect(usage.user).toContain("宿主登录密钥不用于工具");
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
