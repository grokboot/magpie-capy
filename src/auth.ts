import { createCapyClient } from "./client.ts";
import { normalizeApiKey, type Environment } from "./config.ts";
import { CapyError } from "./errors.ts";
import type { FetchLike } from "./http.ts";

export interface AuthRuntime {
  fetchImpl?: FetchLike;
  env?: Environment;
  now?: () => number;
  accountKey?: () => string;
}

export interface HostAuthState {
  key: string | null;
  verified: boolean;
  checkedAt: number | null;
  projectCount: number | null;
  error: string | null;
  multiAccount: boolean;
}

interface VerifyResult {
  ok: boolean;
  code: "ok" | "unauthorized" | "permission" | "network" | "configuration";
  projectCount: number | null;
  error: string | null;
}

const VERIFY_TTL_MS = 60_000;
const VERIFY_TIMEOUT_MS = 8_000;
const MULTI_ACCOUNT_ERROR =
  "检测到多个 Capy 宿主账号。工具调用没有账号上下文，因此不会猜测使用哪个账号。请只保留一个 Capy 登录，或设置 CAPY_API_KEY 环境变量来明确工具使用的密钥；更改账号后请重新加载插件。";
const LOGOUT_SCOPE =
  "在 Magpie 中移除或清除登录只删除本机保存的 Key，不会撤销 Capy 服务端的 Key；撤销与重建请在 Capy 的 Settings → API 中操作。";

function envScopeNote(hasEnvKey: boolean): string {
  return hasEnvKey
    ? "环境变量优先：仅清除 Magpie 登录不会停用 CAPY_API_KEY。" + LOGOUT_SCOPE
    : LOGOUT_SCOPE;
}

function initial(): HostAuthState {
  return {
    key: null,
    verified: false,
    checkedAt: null,
    projectCount: null,
    error: null,
    multiAccount: false,
  };
}

function envKey(env: Environment): { key: string | null; error: string | null } {
  const raw = env.CAPY_API_KEY;
  if (typeof raw !== "string" || raw.trim() === "") return { key: null, error: null };
  try {
    return { key: normalizeApiKey(raw, "CAPY_API_KEY"), error: null };
  } catch {
    return {
      key: null,
      error: "环境变量 CAPY_API_KEY 格式无效（为空、过长或含空白/控制字符）。工具会因此失败；请修正或移除它。",
    };
  }
}

export function createCapyAuth(runtime: AuthRuntime = {}) {
  const env = runtime.env ?? process.env;
  let state = initial();
  let cache: { key: string; at: number; result: VerifyResult } | null = null;
  let generation = 0;
  const seen = new Set<string>();
  let multiAccount = false;

  const clear = (error: string | null = null) => {
    generation += 1;
    state = { ...initial(), error };
    cache = null;
  };

  const remember = (auth: unknown): { key: string | null; error: string | null } => {
    const value = auth as { type?: unknown; key?: unknown } | null;
    if (value?.type !== "api" || typeof value.key !== "string" || value.key.trim() === "") {
      seen.clear();
      multiAccount = false;
      clear();
      return { key: null, error: null };
    }

    let key: string;
    try {
      key = normalizeApiKey(value.key, "Capy 登录");
    } catch {
      seen.clear();
      multiAccount = false;
      clear("保存的 Capy API Key 格式无效，请重新配置。");
      return { key: null, error: state.error };
    }

    const account = runtime.accountKey?.() ?? "";
    if (account) seen.add(account);
    if (seen.size > 1) {
      multiAccount = true;
      generation += 1;
      state = { ...initial(), multiAccount: true, error: MULTI_ACCOUNT_ERROR };
      cache = null;
      return { key, error: MULTI_ACCOUNT_ERROR };
    }

    if (state.key !== key) {
      generation += 1;
      state = { ...initial(), key };
      if (cache?.key !== key) cache = null;
    }
    return { key, error: multiAccount ? MULTI_ACCOUNT_ERROR : null };
  };

  const verify = async (key: string): Promise<VerifyResult> => {
    const now = runtime.now?.() ?? Date.now();
    if (cache && cache.key === key && now - cache.at < VERIFY_TTL_MS) return cache.result;

    let result: VerifyResult;
    try {
      const client = createCapyClient({
        apiKey: key,
        ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}),
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      const projects = await client.listProjects();
      result = { ok: true, code: "ok", projectCount: projects.items.length, error: null };
    } catch (error) {
      if (error instanceof CapyError && error.code === "unauthorized") {
        result = {
          ok: false,
          code: "unauthorized",
          projectCount: null,
          error:
            "Capy 未接受该 API Key（HTTP 401）：它可能已过期或被撤销。请在 Capy 的 Settings → API 中新建 Key，然后在 Magpie 中移除旧登录并重新添加。" +
            LOGOUT_SCOPE,
        };
      } else if (error instanceof CapyError && error.code === "forbidden") {
        result = {
          ok: false,
          code: "permission",
          projectCount: null,
          error:
            "该 Key 的只读项目访问被拒绝（HTTP 403）。Key 所属主体可能没有项目读取权限，或项目范围不含任何项目；请让组织管理员在 Capy 中调整角色/项目访问，Magpie 不会为此提权。",
        };
      } else if (error instanceof CapyError && error.code === "configuration") {
        result = {
          ok: false,
          code: "configuration",
          projectCount: null,
          error: "Capy API Key 格式无效，请重新复制后配置。",
        };
      } else if (error instanceof CapyError && error.code === "timeout") {
        result = {
          ok: false,
          code: "network",
          projectCount: null,
          error: `只读验证请求超时（${VERIFY_TIMEOUT_MS / 1000} 秒内未完成 GET /api/v1/projects）。请检查网络后在 Capy 用法卡片中重试。`,
        };
      } else if (error instanceof CapyError && error.code === "aborted") {
        result = { ok: false, code: "network", projectCount: null, error: "验证已取消，未保存任何密钥。" };
      } else {
        result = {
          ok: false,
          code: "network",
          projectCount: null,
          error: "无法验证 Capy 连接。请检查网络后，在 Capy 用量卡片中重试。",
        };
      }
    }
    if (result.ok) cache = { key, at: now, result };
    return result;
  };

  const applyIfCurrent = (key: string, gen: number, result: VerifyResult): boolean => {
    if (gen !== generation || state.key !== key || multiAccount) return false;
    state = {
      ...state,
      verified: result.ok,
      checkedAt: runtime.now?.() ?? Date.now(),
      projectCount: result.projectCount,
      error: result.error,
    };
    if (result.code === "unauthorized") state.key = null;
    return true;
  };

  const hooks = {
    config: async (cfg: { provider?: Record<string, unknown> }) => {
      cfg.provider ??= {};
      cfg.provider.capy ??= {
        name: "Capy",
        api: "https://api.capy.ai",
        models: {},
      };
    },
    auth: {
      provider: "capy",
      methods: [
        {
          type: "api" as const,
          label: "配置 Capy 组织 API Key",
          placeholder: "capy_…",
          // The host saves an api key as-is unless the method validates it with
          // authorize(). A password prompt makes the host ask for the key itself
          // (masked), and nothing is persisted unless authorize returns success.
          prompts: [
            {
              type: "password" as const,
              key: "key",
              message: "Capy 组织 API Key（在 capy.ai 正常登录后到 Settings → API 手动创建）",
              placeholder: "capy_…",
              validate: (value: unknown): string | null => {
                if (typeof value !== "string") return "请粘贴 Capy API Key。";
                try {
                  normalizeApiKey(value, "Capy API Key");
                  return null;
                } catch {
                  return "Key 不能为空，也不能含空格或换行；请从 Capy Settings → API 重新复制。";
                }
              },
            },
          ],
          async authorize(
            inputs: Record<string, unknown> = {},
            context: { signal?: AbortSignal } = {},
          ): Promise<{ type: "success"; key: string } | { type: "failed"; error: string }> {
            let key: string;
            try {
              key = normalizeApiKey(typeof inputs.key === "string" ? inputs.key : "", "Capy API Key");
            } catch {
              return { type: "failed", error: "Capy API Key 为空或格式不正确，未保存。请重新复制后粘贴。" };
            }
            if (context.signal?.aborted) {
              return { type: "failed", error: "登录已取消，未保存任何密钥。" };
            }
            const result = await verify(key);
            if (context.signal?.aborted) {
              cache = null;
              return { type: "failed", error: "登录已取消，未保存任何密钥。" };
            }
            if (!result.ok) return { type: "failed", error: result.error ?? "Capy 连接未通过验证，未保存。" };
            // The host writes the key only after this success; Magpie is still
            // not "connected" until the host hands it back through getAuth().
            return { type: "success", key };
          },
        },
      ],
      async loader(getAuth: () => Promise<unknown>) {
        remember(await getAuth());
        return {};
      },
      async usage(getAuth: () => Promise<unknown>) {
        const remembered = remember(await getAuth());
        const fromEnv = envKey(env);
        if (fromEnv.error) {
          return {
            plan: "Capy",
            user: "环境变量配置错误",
            windows: [],
            error: fromEnv.error,
          };
        }
        if (multiAccount) {
          return {
            plan: "Capy",
            user: "多个宿主账号，工具已停止自动选择",
            windows: [],
            error: MULTI_ACCOUNT_ERROR,
          };
        }

        const source = fromEnv.key ? "env" : "host";
        const key = fromEnv.key ?? remembered.key;
        if (!key) {
          return {
            plan: "Capy",
            user: "未配置",
            windows: [],
            error:
              remembered.error ??
              state.error ??
              "未连接 Capy。请先在 capy.ai 用正常网页/桌面登录进入产品，再到 Capy 的 Settings → API 手动创建组织 API Key，然后点击“配置 Capy 组织 API Key”粘贴。这是明确的手动委托步骤，不是 OAuth，网页登录本身不会让 Magpie 变为已连接。",
          };
        }

        const gen = generation;
        const result = await verify(key);
        const applied = source === "host" && remembered.key ? applyIfCurrent(remembered.key, gen, result) : true;
        if (!applied) {
          return {
            plan: "Capy",
            user: "登录状态在验证期间发生变化",
            windows: [],
            error: "验证结果已过期；请重新打开用量或插件页刷新状态。",
          };
        }
        const shadow =
          fromEnv.key && remembered.key && fromEnv.key !== remembered.key
            ? "（环境变量优先；Magpie 登录的 Key 不用于工具）"
            : "";
        const verified = result.ok ? `只读连接已验证 · ${result.projectCount ?? 0} 个项目` : "连接未验证";
        return {
          plan: "Capy",
          user:
            source === "env"
              ? `工具使用环境变量 CAPY_API_KEY · ${verified}${shadow} · ${envScopeNote(true)}`
              : `工具使用 Magpie 登录 · ${verified} · ${envScopeNote(false)}`,
          windows: [],
          ...(result.ok
            ? {}
            : {
                error: result.error ?? "Capy 连接未验证。",
                ...(source === "host" && applied && result.code === "unauthorized" ? { signIn: "expired" } : {}),
              }),
        };
      },
    },
    provider: {
      id: "capy",
      async models(
        provider: { models: Record<string, unknown> },
        context: { auth?: unknown } = {},
      ) {
        const remembered = remember(context.auth);
        const fromEnv = envKey(env);
        if (!remembered.key || multiAccount || fromEnv.error || fromEnv.key) return provider.models;

        const gen = generation;
        const result = await verify(remembered.key);
        applyIfCurrent(remembered.key, gen, result);
        if (result.code === "unauthorized" && gen === generation) {
          throw Object.assign(
            new Error(
              "Capy API Key 未通过只读验证（可能已过期或被撤销）。请在 Capy 的 Settings → API 新建 Key，并在 Magpie 中移除旧登录后重新添加。",
            ),
            { signIn: "expired" },
          );
        }
        return provider.models;
      },
    },
  };

  return {
    hooks,
    hostApiKey: (): string | null => (multiAccount ? null : state.key),
    hostApiKeyError: (): string | null => (multiAccount ? MULTI_ACCOUNT_ERROR : state.error),
    hostAuthState: (): Readonly<HostAuthState> => ({ ...state }),
    reset: () => {
      seen.clear();
      multiAccount = false;
      clear();
    },
  };
}

export function createCapyAuthHooks(runtime: AuthRuntime = {}) {
  return createCapyAuth(runtime).hooks;
}
