import { createCapyClient, type ModelCatalog, type UsageBalance, type UsageReport } from "./client.ts";
import { normalizeApiKey, type Environment } from "./config.ts";
import { CapyError } from "./errors.ts";
import type { FetchLike } from "./http.ts";
import {
  createBrowserOAuthMethod,
  readOAuthConfig,
  refreshOAuth,
  type OAuthRuntime,
  type OAuthSettings,
  type OAuthSuccess,
} from "./oauth.ts";
import { usageWindows, type HostUsage } from "./usage.ts";

export interface AuthRuntime extends OAuthRuntime {
  fetchImpl?: FetchLike;
  env?: Environment;
  now?: () => number;
  accountKey?: () => string;
}

export interface HostAuthState {
  key: string | null;
  authType: "api" | "oauth" | null;
  verified: boolean;
  checkedAt: number | null;
  projectCount: number | null;
  error: string | null;
  multiAccount: boolean;
}

interface Credential {
  type: "api" | "oauth";
  bearer: string;
  refresh?: string;
  expires?: number;
}

interface VerifyResult {
  ok: boolean;
  code: "ok" | "unauthorized" | "permission" | "network" | "configuration";
  projectCount: number | null;
  error: string | null;
}

const VERIFY_TTL_MS = 60_000;
const VERIFY_TIMEOUT_MS = 8_000;
const MODEL_TTL_MS = 5 * 60_000;
const USAGE_TIMEOUT_MS = 10_000;
const MULTI_ACCOUNT_ERROR =
  "检测到多个 Capy 宿主账号。工具调用没有账号上下文，因此不会猜测使用哪个账号。请只保留一个 Capy 登录，或设置 CAPY_API_KEY 环境变量来明确工具使用的密钥；更改账号后请重新加载插件。";
const LOGOUT_SCOPE =
  "在 Magpie 中移除或清除登录只删除本机保存的凭据，不会撤销 Capy 服务端的 Key 或会话；撤销与重建请在 Capy 的 Settings → API 中操作。";
const MAX_BEARER_LENGTH = 16_384;
const BEARER_FORBIDDEN = /[\s\u0000-\u001f\u007f]/;

function envScopeNote(hasEnvKey: boolean): string {
  return hasEnvKey
    ? "环境变量优先：仅清除 Magpie 登录不会停用 CAPY_API_KEY。" + LOGOUT_SCOPE
    : LOGOUT_SCOPE;
}

function initial(): HostAuthState {
  return {
    key: null,
    authType: null,
    verified: false,
    checkedAt: null,
    projectCount: null,
    error: null,
    multiAccount: false,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeBearer(raw: string, source: string): string {
  const value = raw.trim();
  if (value.length === 0) {
    throw new CapyError("configuration", `${source} 为空。`);
  }
  if (value.length > MAX_BEARER_LENGTH || BEARER_FORBIDDEN.test(value)) {
    throw new CapyError("configuration", `${source} 格式无效（过长或含空白/控制字符）。`);
  }
  return value;
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

function usageErrorText(error: unknown): string {
  if (error instanceof CapyError) {
    if (error.code === "unauthorized") {
      return "Capy 拒绝了这个登录（HTTP 401）；它可能已过期或被撤销。请重新登录。这不是 0 余额。";
    }
    if (error.code === "forbidden") {
      return "该主体无权读取 Capy 额度（HTTP 403）；任务工具可能仍然可用。这不是 0 余额。";
    }
    if (error.code === "unavailable" || error.code === "server_error") {
      return `Capy 的计费/额度服务当前不可用（HTTP ${error.status ?? "5xx"}）；额度未知，不是 0 余额。`;
    }
    if (error.code === "timeout") return "读取 Capy 额度超时；额度未知，不是 0 余额。";
    if (error.code === "aborted") return "读取 Capy 额度已取消；额度未知。";
    if (error.code === "rate_limited") return "Capy 限制了额度读取请求（HTTP 429）；额度未知，不是 0 余额。";
    if (error.code === "invalid_response") return "Capy 额度响应不符合公开契约；额度未知，不是 0 余额。";
    if (error.code === "network_error") return "无法连接 Capy 读取额度；额度未知，不是 0 余额。";
    return error.message;
  }
  return "读取 Capy 额度失败；额度未知，不是 0 余额。";
}

export function createCapyAuth(runtime: AuthRuntime = {}) {
  const env = runtime.env ?? process.env;
  let state = initial();
  let credential: Credential | null = null;
  let cache: { bearer: string; at: number; result: VerifyResult } | null = null;
  let modelCache: { bearer: string; at: number; catalog: ModelCatalog } | null = null;
  const modelInflight = new Map<string, Promise<ModelCatalog>>();
  const refreshInflight = new Map<string, Promise<Partial<OAuthSuccess>>>();
  let generation = 0;
  const seen = new Set<string>();
  let multiAccount = false;

  const oauthConfig = readOAuthConfig(env);
  const oauthSettings: OAuthSettings | null =
    oauthConfig.kind === "configured" ? oauthConfig.settings : null;

  const clear = (error: string | null = null) => {
    generation += 1;
    state = { ...initial(), error };
    credential = null;
    cache = null;
    modelCache = null;
  };

  const remember = (auth: unknown): { credential: Credential | null; error: string | null } => {
    const value = record(auth);
    let next: Credential | null = null;

    if (value?.type === "api" && typeof value.key === "string" && value.key.trim() !== "") {
      try {
        next = { type: "api", bearer: normalizeApiKey(value.key, "Capy 登录") };
      } catch {
        seen.clear();
        multiAccount = false;
        clear("保存的 Capy API Key 格式无效，请重新配置。");
        return { credential: null, error: state.error };
      }
    } else if (
      value?.type === "oauth" &&
      typeof value.access === "string" &&
      value.access.trim() !== ""
    ) {
      try {
        next = {
          type: "oauth",
          bearer: normalizeBearer(value.access, "Capy OAuth access token"),
          ...(typeof value.refresh === "string" && value.refresh.trim() !== ""
            ? { refresh: normalizeBearer(value.refresh, "Capy OAuth refresh token") }
            : {}),
          ...(typeof value.expires === "number" && Number.isFinite(value.expires)
            ? { expires: value.expires }
            : {}),
        };
      } catch {
        seen.clear();
        multiAccount = false;
        clear("保存的 Capy OAuth 登录格式无效，请重新登录。");
        return { credential: null, error: state.error };
      }
    } else {
      seen.clear();
      multiAccount = false;
      clear();
      return { credential: null, error: null };
    }

    const account = runtime.accountKey?.() ?? "";
    if (account) seen.add(account);
    if (seen.size > 1) {
      multiAccount = true;
      generation += 1;
      state = { ...initial(), multiAccount: true, error: MULTI_ACCOUNT_ERROR };
      credential = next;
      cache = null;
      modelCache = null;
      return { credential: next, error: MULTI_ACCOUNT_ERROR };
    }

    if (credential?.bearer !== next.bearer || credential?.type !== next.type) {
      generation += 1;
      state = { ...initial(), key: next.bearer, authType: next.type };
      cache = null;
      modelCache = null;
    }
    credential = next;
    return { credential: next, error: multiAccount ? MULTI_ACCOUNT_ERROR : null };
  };

  const verify = async (key: string): Promise<VerifyResult> => {
    const now = runtime.now?.() ?? Date.now();
    if (cache && cache.bearer === key && now - cache.at < VERIFY_TTL_MS) return cache.result;

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
    if (result.ok) cache = { bearer: key, at: now, result };
    return result;
  };

  const applyIfCurrent = (cred: Credential, gen: number, result: VerifyResult): boolean => {
    if (gen !== generation || credential?.bearer !== cred.bearer || multiAccount) return false;
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

  const fetchModelCatalog = async (cred: Credential): Promise<ModelCatalog> => {
    const now = runtime.now?.() ?? Date.now();
    if (modelCache && modelCache.bearer === cred.bearer && now - modelCache.at < MODEL_TTL_MS) {
      return modelCache.catalog;
    }
    const existing = modelInflight.get(cred.bearer);
    if (existing) return existing;
    const pending = (async () => {
      const client = createCapyClient({
        apiKey: cred.bearer,
        ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}),
        timeoutMs: 10_000,
      });
      const catalog = await client.listModels();
      modelCache = { bearer: cred.bearer, at: runtime.now?.() ?? Date.now(), catalog };
      return catalog;
    })();
    modelInflight.set(cred.bearer, pending);
    try {
      return await pending;
    } finally {
      modelInflight.delete(cred.bearer);
    }
  };

  const providerModels = (
    catalog: ModelCatalog,
    defaults: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const item of catalog.items) {
      const existing = record(defaults[item.id]) ?? {};
      result[item.id] = {
        ...existing,
        id: item.id,
        name: item.name,
        reasoning: item.reasoningModes.length > 0,
        ...(item.reasoningModes.length > 0
          ? { variants: Object.fromEntries(item.reasoningModes.map((mode) => [mode, {}])) }
          : {}),
        billing: item.billing,
        route: item.route,
      };
    }
    return result;
  };

  const credentialEnv = (): { credential: Credential | null; error: string | null } => {
    const fromEnv = envKey(env);
    return {
      credential: fromEnv.key ? { type: "api", bearer: fromEnv.key } : null,
      error: fromEnv.error,
    };
  };

  const refresh = async (auth: unknown): Promise<Partial<OAuthSuccess> | undefined> => {
    if (!oauthSettings) return undefined;
    const value = record(auth);
    if (value?.type !== "oauth" || typeof value.refresh !== "string" || value.refresh === "") {
      return undefined;
    }
    const key = value.refresh;
    const existing = refreshInflight.get(key);
    if (existing) return existing;
    const pending = refreshOAuth(oauthSettings, value, runtime).then((next) => {
      if (state.authType === "oauth" && typeof value.access === "string" && state.key === value.access) {
        state = { ...state, key: next.access ?? state.key };
        if (credential?.type === "oauth" && credential.bearer === value.access) {
          credential = { ...credential, bearer: next.access ?? credential.bearer };
        }
      }
      return next;
    });
    refreshInflight.set(key, pending);
    try {
      return await pending;
    } finally {
      refreshInflight.delete(key);
    }
  };

  const usage = async (getAuth: () => Promise<unknown>): Promise<HostUsage> => {
    const remembered = remember(await getAuth());
    const fromEnv = credentialEnv();
    if (fromEnv.error) {
      return { plan: "Capy", user: "环境变量配置错误", windows: [], error: fromEnv.error };
    }
    if (multiAccount) {
      return {
        plan: "Capy",
        user: "多个宿主账号，工具已停止自动选择",
        windows: [],
        error: MULTI_ACCOUNT_ERROR,
      };
    }

    const source = fromEnv.credential ? "env" : "host";
    const cred = fromEnv.credential ?? remembered.credential;
    if (!cred) {
      return {
        plan: "Capy",
        user: "未配置",
        windows: [],
        error:
          remembered.error ??
          state.error ??
          "未连接 Capy。可粘贴组织 API Key，或使用已配置的浏览器 OAuth/OIDC 登录。网页登录本身不会让 Magpie 自动获得凭据。",
      };
    }

    const gen = generation;
    const client = createCapyClient({
      apiKey: cred.bearer,
      ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}),
      timeoutMs: USAGE_TIMEOUT_MS,
    });
    let balance: UsageBalance;
    try {
      balance = await client.getUsageBalance();
    } catch (error) {
      if (error instanceof CapyError && error.code === "unauthorized") {
        const current = gen === generation && credential?.bearer === cred.bearer;
        if (current) {
          state = { ...state, verified: false, checkedAt: runtime.now?.() ?? Date.now(), error: usageErrorText(error) };
          if (source === "host") state.key = null;
        }
        return {
          plan: "Capy",
          user: source === "env" ? "环境变量 CAPY_API_KEY 已被拒绝" : "Magpie 登录已被拒绝",
          windows: [],
          error: current
            ? usageErrorText(error) + (source === "host" ? " " + LOGOUT_SCOPE : "")
            : "验证结果已过期；请重新打开用量或插件页刷新状态。",
          ...(current ? { signIn: "expired" as const } : {}),
        };
      }
      return { plan: "Capy", user: "额度不可用", windows: [], error: usageErrorText(error) };
    }

    let report: UsageReport | null = null;
    let reportError: string | null = null;
    try {
      report = await client.getUsageReport({
        ...(balance.periodStart !== null ? { from: balance.periodStart } : {}),
        ...(balance.periodEnd !== null ? { to: balance.periodEnd } : {}),
      });
    } catch (error) {
      reportError = usageErrorText(error);
    }

    if (gen === generation && credential?.bearer === cred.bearer) {
      state = {
        ...state,
        verified: true,
        checkedAt: runtime.now?.() ?? Date.now(),
        error: null,
      };
    }
    const windows = usageWindows(balance, report, reportError);
    const stateText = balance.unlimited
      ? "额度：无限"
      : balance.remainingDollars === null
        ? "额度：无信用余额（服务端未给出可消费余额）"
        : "额度已读取";
    const shadow =
      source === "env" && remembered.credential && remembered.credential.bearer !== cred.bearer
        ? "（环境变量优先；Magpie 登录的凭据不用于工具）"
        : "";
    const sourceText =
      source === "env"
        ? `工具使用环境变量 CAPY_API_KEY · ${stateText}${shadow}${envScopeNote(true)}`
        : `工具使用 Magpie 登录（${cred.type === "oauth" ? "OAuth/OIDC" : "API Key"}） · ${stateText} · ${envScopeNote(false)}`;
    return {
      plan: "Capy",
      user: sourceText,
      windows,
      ...(typeof balance.remainingDollars === "number"
        ? { balance: `${balance.remainingDollars < 0 ? "-" : ""}$${Math.abs(balance.remainingDollars).toFixed(2)}` }
        : {}),
    };
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
            return { type: "success", key };
          },
        },
        ...(oauthSettings
          ? [createBrowserOAuthMethod(oauthSettings, runtime)]
          : oauthConfig.kind === "invalid"
            ? [
                {
                  type: "oauth" as const,
                  label: "浏览器 OAuth/OIDC 登录（配置不完整）",
                  async authorize(): Promise<never> {
                    throw new Error(oauthConfig.error);
                  },
                },
              ]
            : []),
      ],
      async loader(getAuth: () => Promise<unknown>) {
        remember(await getAuth());
        return {};
      },
      async usage(getAuth: () => Promise<unknown>) {
        return usage(getAuth);
      },
      ...(oauthSettings
        ? {
            async refresh(auth: unknown) {
              return refresh(auth);
            },
          }
        : {}),
    },
    provider: {
      id: "capy",
      async models(
        provider: { models: Record<string, unknown> },
        context: { auth?: unknown } = {},
      ) {
        const remembered = remember(context.auth);
        const fromEnv = credentialEnv();
        if (fromEnv.error || multiAccount) return provider.models;
        const cred = fromEnv.credential ?? remembered.credential;
        if (!cred) return provider.models;

        const gen = generation;
        try {
          const catalog = await fetchModelCatalog(cred);
          if (gen === generation && credential?.bearer === cred.bearer) {
            state = {
              ...state,
              verified: true,
              checkedAt: runtime.now?.() ?? Date.now(),
              error: null,
            };
          }
          return providerModels(catalog, provider.models);
        } catch (error) {
          if (error instanceof CapyError && error.code === "unauthorized") {
            const current = gen === generation && credential?.bearer === cred.bearer;
            if (current) {
              state = { ...state, key: null, verified: false, error: usageErrorText(error) };
              throw Object.assign(
                new Error(
                  "Capy 登录未通过模型目录验证（可能已过期或被撤销）。请重新登录；这不是模型不存在。",
                ),
                { signIn: "expired" },
              );
            }
            if (modelCache && modelCache.bearer === cred.bearer) {
              return providerModels(modelCache.catalog, provider.models);
            }
            return provider.models;
          }
          if (modelCache && modelCache.bearer === cred.bearer) {
            return providerModels(modelCache.catalog, provider.models);
          }
          return provider.models;
        }
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
