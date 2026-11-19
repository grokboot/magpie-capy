# magpie-capy 0.2.1

Capy 任务平台工具（非模型提供方）。在 Magpie 中配置组织 API Key 后，智能体可读取项目、线程、子代理、消息，并以有界时间观察线程 SSE；写入默认关闭。

许可证：MIT（源码）。Capy 名称与图标属于 Capy 品牌，归属见 `docs/attribution.md`。

## 安装

从 GitHub 安装：

```bash
git clone https://github.com/grokboot/magpie-capy
magpie plugin add ./magpie-capy
```

发布归档解压后的顶层文件夹同样固定为 `magpie-capy/`：

```bash
tar -xzf magpie-capy-0.2.1.tgz
magpie plugin add ./magpie-capy
```

桌面版：选择解压后的 `magpie-capy` 文件夹；开发时也可选源码目录。添加、更新、开关插件会重启插件宿主；修改源码后关闭再开启插件。

## 配置 API Key

1. 在 **Capy 设置 → API** 手动创建组织 API Key（明文只显示一次）。
2. 在 Magpie 的 **插件 → Capy（任务工具）** 行点击 **配置 Capy 组织 API Key**，粘贴密钥。
3. Magpie 将密钥保存在自己的 `plugin-auth.json`（600 权限）。插件不会把密钥写入公开选项、页面、URL、日志或工具结果。
4. 登录/刷新时会做一次只读 `GET /api/v1/projects` 验证。用量卡片会区分“仅已配置”和“只读连接已验证”；401 会标记登录过期。

兼容旧安装：环境变量 `CAPY_API_KEY` 仍有效且优先于已保存登录；用量卡片会明确工具实际使用哪个来源。环境变量格式无效会显示配置错误，不会谎称已验证。

Magpie 可保存多个宿主账号，但工具调用没有账号选择器。检测到多个账号时，工具会安全停止并提示只保留一个账号或显式设置 `CAPY_API_KEY`，不会静默使用最后登录的账号。Capy Dock 配对不是组织 REST API Key。

### 清除

使用 Magpie 插件行的退出登录，或：

```bash
magpie plugin logout capy
```

然后按需移除 `CAPY_API_KEY`。宿主认证文件由 Magpie 管理；刚退出时内存中的旧密钥可能持续到下一次 provider 刷新，因此不要把它当作工具级会话边界。

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
- 父级 GUI 验收已覆盖 0.2.1 提取归档的图标、中文 README、版本/MIT、Options `false` 持久化和登录/取消流程；未使用真实 Capy API 凭证，未验证真实 API 端到端成功。详见 `docs/compatibility.md`、`docs/ux-auth-exposure.md`。
