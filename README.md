# magpie-capy 0.3.0

**Capy 任务平台桥 · MIT 源码许可 · 品牌归属见 `docs/attribution.md`**

在 Magpie 中配置 Capy 组织 API Key（或可选的 OAuth/OIDC 浏览器登录）后，智能体可读取动态模型目录、真实额度、项目/线程/子代理/任务与消息，并用有界 SSE 观察；`run_task` 是一个明示的 Capy 任务代理，不是直连模型 API。写入默认关闭。

> English overview: [below](#english). 中文完整说明也保存在 `README.zh-CN.md`。

## 功能支持矩阵

| 能力 | 实现依据 | 离线状态 | 真实 Capy 实测 | 已知阻塞 |
| --- | --- | --- | --- | --- |
| 组织 API Key 登录 | 公开 API + 现有宿主 auth 契约 | 已实现，prompt/授权/取消/401 均有 mock 测试 | 0.2.3 曾做过一次 `list_projects` 只读验证 | Key 权限随 principal，未验证 scope/到期元数据 |
| 动态模型目录 | 公开 `GET /api/v1/models` | 已实现并映射 `id/name/reasoningModes` 等；不伪造 context/tool 支持 | 本 turn 未联网 | 无 |
| 额度/周期消费 | 公开 `GET /api/v1/usage/balance` + `GET /api/v1/usage` | 已实现 numeric/null/unlimited、周期报告、失败原因；不伪造 0 | 本 turn 未联网 | `remainingDollars` 是剩余美元，不是 entitlement；报告只有消费，不冒充上限 |
| 模型选择 | 公开 `ModelSelection` on create/send | `create_thread`、`send_message`、`run_task` 可传 `model` | 本 turn 未联网 | 无 |
| 任务生命周期读取 | 公开 tasks list/get/messages/stream | `list_tasks`、`get_task`、`list_task_messages`、`watch_task` | 本 turn 未联网 | 无 |
| 显式任务代理 | create → list tasks → watch | `run_task` 返回 thread/tasks/observation，`complete` 只认任务流自己的 `done` | 本 turn 未联网；测试用 mock | 创建/发消息可能计费或执行命令 |
| 浏览器 OAuth/OIDC | 公开 OIDC discovery + PKCE + 本机回环回调 | 已实现 state/PKCE、回调、code 交换、refresh；配置缺失时 feature gate 明确 | 本 turn 未联网，使用 mock issuer | Capy 官方第三方 client/redirect/audience 登记未公开；不能声称是 Capy 官方委托 |
| 浏览器登录使用 Capy 自身 Clerk 会话 | 桌面静态链已证实 Clerk、`capy://app/`、mint/rotatedJwt | 未实现为插件契约 | 未实测 | 缺公开第三方 client/redirect/audience 与 session JWT 的 `/api/v1` 受众确认 |

## 安装与升级

首选官方 CLI 的 GitHub 规格安装：

```bash
magpie plugin add github:grokboot/magpie-capy
```

桌面版：**插件 → 添加插件 → GitHub**，填入 `grokboot/magpie-capy`。发布归档顶层文件夹固定为 `magpie-capy/`：

```bash
tar -xzf magpie-capy-0.3.0.tgz
magpie plugin add ./magpie-capy
```

开发时也可直接装源码目录。0.2.3 的包与 tag 不改；本版本是新的预览版本。`Discover` 中本插件应标为 **Unofficial**，不是 Capy 或 Magpie 官方插件。GitHub 发布已获授权；npm 发布仍待认证，不声称 npm 已发布。

## 登录/配置

### API Key（默认可用）

1. 在 **Capy 设置 → API** 手动创建组织 API Key。
2. 在 Magpie 的 **插件 → Capy** 行点击 **配置 Capy 组织 API Key**。
3. Magpie 将密钥保存在自己的 `plugin-auth.json`（600）；插件不把密钥写入公开选项、页面、URL、日志或工具结果。
4. 授权时做一次有界只读 `GET /api/v1/projects` 验证；取消或失败不保存。

兼容旧安装：`CAPY_API_KEY` 仍有效且优先；用量卡片会说明工具实际使用环境变量还是 Magpie 登录。检测到多个宿主账号时工具会安全停止，不会静默选择。`magpie plugin logout capy` 只清除本地凭据，不是服务端撤销。

### 浏览器 OAuth/OIDC（可选，需自备公开 client 配置）

本版本新增一个真实的 PKCE 浏览器方法，但它**不是 Capy 官方第三方 client**，默认不出现；设置以下环境变量后才出现：

```bash
export CAPY_OAUTH_ISSUER=https://your-issuer.example
export CAPY_OAUTH_CLIENT_ID=your-public-client-id
export CAPY_OAUTH_REDIRECT_URI=http://127.0.0.1:53682/callback
# 可选
export CAPY_OAUTH_SCOPES="openid profile email"
export CAPY_OAUTH_AUDIENCE=capy
# 仅 confidential client 才需要；public PKCE client 留空
# export CAPY_OAUTH_CLIENT_SECRET=...
```

方法使用 OIDC discovery、S256 PKCE、state 校验和本机 loopback 回调，成功后按 Magpie 的 `oauth` 凭据保存 access/refresh/expires；若配置了 refresh token，宿主 `auth.refresh` 使用 `refresh_token` grant。`CAPY_OAUTH_REDIRECT_URI` 必须是 `http://127.0.0.1` / `localhost` 回环地址。

**边界**：Capy 自己是否接受该 issuer 的 access token 作为 `/api/v1` bearer、以及是否登记了该 client/redirect/audience，未由公开契约确认。使用前请确认 issuer 与 token 受众；这不能被宣传成“Capy 官方网页授权”。Capy 桌面确有 Clerk → `capy://app/` → mintToken/rotatedJwt 链，但本轮没有把它做成插件登录契约。

## 模型目录、额度与任务

- `provider.models` 读取公开 `GET /api/v1/models`，按账户缓存 5 分钟；只映射契约字段 `id/name/reasoningModes/fast/pro/ultrafast/billing/route`。`reasoningModes` 映射为 `variants`；不填契约没有的 context/output/tool 支持，也不伪造 provider 徽标。
- `auth.usage` 读取 `GET /api/v1/usage/balance`，再读当前订阅周期（无 plan 时为 UTC 当月）的 `GET /api/v1/usage`。窗口区分：剩余美元、`unlimited`、无信用余额、周期总消费/已计费；`null` 不显示为 0。失败时显示“额度未知”及原因，例如 401/403/503/超时。
- 任务工具：`list_tasks`、`get_task`、`list_task_messages`、`watch_task` 使用公开 tasks 端点；`watch_task` 的 `time_limit` 不是任务失败或完成。
- `run_task`：创建线程（可选 `model`）→ 列出该线程任务 → 有界观察最新任务。返回 `thread`、`tasks`、`observation`、`complete`、`taskPending`。`complete` 只由任务流自己的 `done` 帧置为 true；超时/无任务返回 false，不冒充完成。创建可能计费、执行命令或创建 PR。

## 写入与工具

写入默认关闭。启用方式：非密钥 Options `{"allowWrites":true}`，或环境变量 `CAPY_ALLOW_WRITES=true`。每次写入仍须 `confirm:true`；它只是调用方声明，不是人工审批边界。共 15 个工具：

```text
list_projects, list_threads, get_thread, list_messages,
list_subagents, list_subagent_messages, watch_thread,
create_thread, send_message, interrupt_thread,
list_tasks, get_task, list_task_messages, watch_task, run_task
```

`create_thread`/`send_message`/`run_task` 可传 `model: {modelId, reasoningMode?, modes?}`；省略时由 Capy 按公开默认链选择。

## 测试与限制

- `bun run check`、`bun run check:openapi`、`npm pack --dry-run`。
- 156 个离线 mock 测试、typecheck 通过；模式测试覆盖动态模型目录、真实额度窗口、任务生命周期、`run_task`、OAuth PKCE/回调/取消/刷新、写入守卫和参数验证。测试只使用合成凭据和 mock fetch，不发起真实 Capy 请求，不读取运行时 auth store/cookie/session 文件。
- 本 turn 未做真实 Capy 登录、额度、生成、任务或写请求；因此不声称这些路径已联网验收。真实 Capy 是否接受 OAuth token 是上述外部依赖。
- `provider` 徽标由 Magpie 宿主分类决定；本插件不伪造模型来强制显示。`Tools` 暴露由宿主控制；看到“已对智能体隐藏”时点击 **交给智能体**。
- RocksDB/CLI 本地 logout 只清本地凭据；`CAPY_API_KEY` 可覆盖 UI 退出并继续授权工具。多账号时工具 fail closed。
- 归档脚本把条目/gzip 时间改写为真实构建时间或显式 `SOURCE_DATE_EPOCH`；归档测试在 UTC/Asia/Shanghai/America/Los_Angeles 校验条目元数据。

## English

A Magpie bridge for Capy's public task platform. It adds dynamic model discovery (`GET /api/v1/models`), real credit balance and current-period spend (`GET /api/v1/usage/balance`, `GET /api/v1/usage`), documented model selection on writes, task lifecycle reads (`list_tasks`/`get_task`/`list_task_messages`/`watch_task`), and an explicit `run_task` proxy (create thread → list tasks → bounded observe). `run_task.complete` is true only when the task stream's own `done` frame arrives; timeouts and empty task lists stay false. It does not claim to be a direct chat-completion or model API.

Authentication: the verified default is an organization API Key pasted into Magpie's masked prompt and checked with one bounded read-only project list before saving. A feature-gated browser OAuth/OIDC method is also implemented: OIDC discovery, S256 PKCE, state check, loopback callback, code exchange, and refresh_token rotation via `auth.refresh`. It is **not** a Capy official third-party client; set `CAPY_OAUTH_ISSUER`, `CAPY_OAUTH_CLIENT_ID`, and a loopback `CAPY_OAUTH_REDIRECT_URI` to enable it. Capy's public contract does not confirm that its `/api/v1` accepts that issuer's token, nor that Capy registered the client/redirect/audience. Capy's own desktop Clerk → `capy://app/` → mintToken/rotatedJwt chain is statically confirmed, but is not exposed here as an official third-party login contract.

Usage honesty: `remainingDollars` is mapped to a credit window; `unlimited` and a null (no credit balance) remain distinct; null is never rendered as zero. Current-period totals and billed dollars are display-only because the public balance response does not provide an entitlement denominator or used percent. Failures say the balance is unknown and why; they never fabricate a zero balance.

Writes are off by default (`{"allowWrites":true}` or `CAPY_ALLOW_WRITES=true`), and every write still requires caller `confirm:true`. Model selection is the documented `model` object; omission uses Capy's default chain. All 156 tests are offline mocks; this turn made no live Capy requests, so no live task/credit/model acceptance is claimed. The 0.2.3 artifact and tag are unchanged; this is a new 0.3.0 preview. GitHub installation is supported; npm publication is pending authentication, so npm availability is not claimed.
