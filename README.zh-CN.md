# magpie-capy 0.2.3

Capy 任务平台工具（非模型提供方）。普通产品登录委托尚未验证；当前可用高级路径是在 Capy 设置中创建组织 API Key，再在 Magpie 中配置。写入默认关闭。

许可证：MIT（源码）。Capy 名称与图标属于 Capy 品牌，归属见 `docs/attribution.md`。

## 安装

首选官方 CLI 的 GitHub 规格安装：

```bash
magpie plugin add github:grokboot/magpie-capy
```

桌面版：**插件 → 添加插件 → GitHub**，填入 `grokboot/magpie-capy`。

`Discover` 中本插件应标为 **Unofficial**，不是 Capy 或 Magpie 官方插件。GitHub 的 `magpie-plugin` topic 是官方未审阅收录路径，但不保证立即出现：仓库已被 GitHub 搜索索引，只有实际应用目录包含本插件后才可能显示。GitHub 预构建目录在 48 小时内优先；目录不可用时回退到客户端缓存的 topic 查询（约 10 分钟）或实时 GitHub 查询。精选 registry 是独立的推荐列表，最多每 6 小时刷新。没有“等 10 分钟就会出现”的承诺，当前也不宣称 Discover 已显示。

发布归档解压后的顶层文件夹同样固定为 `magpie-capy/`：

```bash
tar -xzf magpie-capy-0.2.2.tgz
magpie plugin add ./magpie-capy
```

0.2.2 归档保持不可变。npm 发布元数据已准备；0.2.3 计划在 GUI 验收通过且 npm 认证就绪后公开发布，当前不声称已发布。发布后可用 npm 安装，GitHub 安装仍作为替代路径；标准 npm tgz 顶层为 `package/`，不代表解压后手动文件夹安装是稳定路径。

开发时也可直接装源码目录：

```bash
git clone https://github.com/grokboot/magpie-capy
magpie plugin add ./magpie-capy
```

添加、更新、开关插件会重启插件宿主；修改源码后关闭再开启插件。

## 配置 API Key

1. 先用正常网页/桌面入口登录 capy.ai（这一步只是使用产品，不会让 Magpie 自动连接）。
2. 在页面中进入 **Settings → API**，手动创建组织 API Key（明文只显示一次）。这是明确的手动委托步骤，不是 OAuth。
3. 在 Magpie 的 **插件 → Capy** 行点击 **配置 Capy 组织 API Key**；宿主用遮罩输入框询问密钥。Magpie 只有在一次有界（8 秒）的只读 `GET /api/v1/projects` 验证成功后才保存它；取消或验证失败不会保存任何密钥。
4. 密钥由宿主保存在 Magpie 自己的 `plugin-auth.json`（600 权限）。本插件不写自己的密钥文件，也不会把密钥放进公开选项、页面、URL、日志或工具结果。
5. 加载/刷新时会复用这次只读验证结果。用量卡片会区分“未配置 / 连接未验证 / 只读连接已验证”；401（过期或撤销）会给出可读提示并标记登录过期，403 会说明是主体角色或项目范围不足，Magpie 不会为此提权。

兼容旧安装：环境变量 `CAPY_API_KEY` 仍有效且优先于已保存登录；用量卡片会明确工具实际使用哪个来源。环境变量格式无效会显示配置错误，不会谎称已验证。

Magpie 可保存多个宿主账号，但工具调用没有账号选择器。检测到多个账号时，工具会安全停止并提示只保留一个账号或显式设置 `CAPY_API_KEY`，不会静默使用最后登录的账号。注意 `CAPY_API_KEY` 会覆盖 UI 登录状态；本地 logout 只清除本地保存的授权，不等于服务端撤销。Capy Dock 配对不是组织 REST API Key。

### 清除

本地清除请使用官方 CLI 路径，执行后按需移除环境变量（本次验收未找到 Magpie 宿主 UI 可用的本地退出入口；移除插件会卸载但保留授权，移除 Provider 仍保持 Capy 登录状态，二者都不是退出登录）：

```bash
magpie plugin logout capy
```

然后按需移除 `CAPY_API_KEY`。

- 退出后插件会在下一次宿主 provider 刷新时清空内存密钥和验证缓存，之后的工具调用会按“缺少凭据”失败；如果环境变量 `CAPY_API_KEY` 已设置，工具仍会使用它（环境变量优先），此时清除 Magpie 登录不会停用工具。
- 本地清除/退出只删除本机凭据，**不会撤销 Capy 服务端的 Key**；撤销与重建请在 Capy 的 Settings → API 操作。

## 把工具交给智能体

看到 **工具，已对智能体隐藏** 时，这是 Magpie 的暴露设置，不是插件损坏。点击 **交给智能体**，再到 Library → MCP 或路由器中确认目标智能体。可按智能体分别开启/关闭。也可以手动把 `http://127.0.0.1:3425/mcp/magpie/tools` 加到 MCP 客户端。隐藏状态会跨更新、重启和开关保留；没有插件清单级的默认暴露覆盖。

## 写入

默认关闭。需要时设置环境变量：

```bash
export CAPY_ALLOW_WRITES=true
```

或使用**非密钥**插件选项 `{"allowWrites":true}`。每次写入仍须 `confirm:true`；它只是调用方声明，不是人工审批或授权边界。创建/发消息可能执行命令、消耗额度或创建 PR。

## 从 0.1.0 升级

在 Magpie 中更新或重新添加本目录。已保存的插件登录位于 Magpie 的 `plugin-auth.json`，通常不会因重新加载源码而丢失；环境变量也不受影响。升级后请重新检查插件行图标、版本与“配置/登录”入口。

## 已知宿主边界

- 本地文件夹详情与 npm registry 卡片使用的元数据来源不同，仅靠 `package.json` 无法完全补齐 registry 的版本/许可证/摘要展示。
- 发布归档使用仓库内脚本把归档条目和 gzip 头时间改写为真实构建时间（或显式 `SOURCE_DATE_EPOCH`），避免 npm 归一化的 1985 时间；本地文件夹复制后仍可能沿用文件系统时间。
- “已对智能体隐藏”、MCP 路由和按智能体授权都由 Magpie 宿主控制。

## 测试与限制

- 运行：`bun run check`、`bun run check:openapi`、`npm pack --dry-run`。
- 测试只使用合成密钥和 mock fetch，不发起真实 Capy 请求。
- 0.2.1 的历史 GUI 验收覆盖图标、中文 README、版本/MIT、Options `false` 持久化和登录/取消流程，不适用于新版本。0.2.3 的 GUI 验收已通过名称/图标、中文 README、10 个工具、授权状态和 Options `allowWrites=false` 持久化；GUI 本地退出和提示取消未验证，不能写成完整 GUI 已通过。
- 本插件只提供 Capy 任务工具，使用 Magpie 的零模型认证桥，不是聊天推理提供方。登录不使用 OAuth：正常路径是 Capy 网页邮箱登录，在 Settings 创建 API Key，再在 Magpie 的密码输入框中手动粘贴并显式委托。Key 本身不是只读类型，也没有自带 scope，权限随 principal；建议使用专用只读服务账号并设置到期时间（如 30 天），但未验证具体 scope、principal 映射或到期元数据。写入默认关闭，保存 `allowWrites` 或设置 `CAPY_ALLOW_WRITES=true` 后仍需每次 `confirm:true`。基础原生认证、只读项目列表（HTTP 200，空结果）、无 `CAPY_API_KEY` 环境下带持久认证重启、官方退出后无 `CAPY_API_KEY` 重启工具未授权（`isError: true`）已做端到端验证；没有项目数据，因此 subagent、SSE、message 和 write 路径未做实际运行验证；测试套件共 117 项。官方 CLI 本地退出只清除本地凭据，不是服务端吊销；`CAPY_API_KEY` 可覆盖 UI 退出并继续授权工具，这是已知风险。0.2.3 GUI 仅通过上述子集，GUI 本地退出和提示取消未验证，完整 GUI 尚未通过。0.2.3 的 GitHub 发布已获授权，npm 发布仍待认证，不声称 npm 已发布；发布包已存在，使用官方 Magpie CLI 和稳定插件 ID 的标准安装方式；npm 发布后使用标准 npm 安装。不要手动加载解压后的包目录。
- 受控端到端验证使用已批准的服务账号 Key，官方 Magpie CLI 原生授权保存到宿主存储后，执行一次公开只读 `list_projects`（HTTP 200，空列表）；网关重启后可从持久化授权继续成功，官方 CLI 本地 logout 后工具无授权失败。117 个 mock 测试在 UTC 与 Asia/Shanghai 时区通过，typecheck 通过，未暴露原始 payload、日志或 Key。由于没有项目数据，未覆盖 subagent、SSE、消息创建/发送/打断，也未验证全部 API；0.2.3 GUI 仅通过上述子集，GUI 本地退出和提示取消未验证。CLI 本地 logout 只清除本地授权，不等于服务端撤销；环境变量 `CAPY_API_KEY` 可覆盖 UI 退出并保持授权。
- 归档测试直接校验 tar 头 epoch，并在 UTC、Asia/Shanghai、America/Los_Angeles 三种时区下验证条目元数据一致，不依赖本地时区显示。详见 `docs/compatibility.md`、`docs/ux-auth-exposure.md`。
