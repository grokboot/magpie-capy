# UX, auth and exposure

## Auth

Capy documents organization API keys. This plugin does not implement OAuth, device login, browser/session reuse, or credential discovery. It exposes only Capy task tools through a zero-model auth bridge, not chat inference. The intended flow is Capy web email login, then Settings to create an API Key, then explicit manual delegation by pasting the key into Magpie's native password input. The key is not a read-only key type, has no scopes of its own, and permissions follow the principal. Use a dedicated read-only service user and an expiry such as 30 days where possible; no specific scope, principal mapping, or expiry metadata was verified. Basic native authorization and a read-only project-list call were verified end to end. The 0.2.3 GUI check passed name, icon, Chinese README, 10 tools, authorized status, and Options `allowWrites=false` persistence; GUI local logout and prompt cancel were not verified, so this is not a complete GUI pass.

Badge behavior depends on the Magpie host. A real GUI check of plugin 0.2.2 showed only the `Tools` badge; earlier checks showed both `Tools` and `Provider`. Capy exposes tools through a separate MCP tool server backed by Capy's public task API. The `capy` auth hook is Magpie's zero-model authentication namespace only: it is used for the login entry (`provider id capy`, one `type: "api"` method labelled `配置 Capy 组织 API Key`, and a `provider.models` callback that registers no models). It has no models and no inference path. A zero-model native auth bridge is not a model provider and does not guarantee a `Provider` badge; whether that badge appears is owned by the host version and its classification logic, so it is not guaranteed and is not currently claimed. Keep authentication separate from the MCP tool server. Do not fake a model or change host classification to force a `Provider` badge.

Magpie stores the key in its own `plugin-auth.json`; the plugin only caches it in host-process memory. `provider.models` performs one read-only `GET /api/v1/projects` verification. `auth.usage` reports configured, verified, unverified, malformed and expired states. A controlled end-to-end check covered native authorization, a read-only project-list call, restart with persisted native auth, and CLI local logout/clear; it did not cover all APIs. The 0.2.3 GUI check passed only the subset above, and GUI local logout and prompt cancel were not verified. There was no project data, so subagent, SSE, message create/send, and interrupt paths were not exercised live. 117 mock tests passed in UTC and Asia/Shanghai, and typecheck passed. No raw payloads, logs, or keys were exposed. CLI local logout is not server-side revocation, and `CAPY_API_KEY` takes precedence and can keep tools authorized after UI logout, so this is a documented risk. Multiple host accounts fail tools closed rather than selecting an arbitrary account. A 401 clears tool use, while the host credential remains available for deliberate re-login.

`client.auth.get` is not a supported Magpie client method; only `auth.set/remove` and `getAuth` callbacks are used.

## Exposure

`工具，已对智能体隐藏` / *Tools, hidden from agents* is host-controlled exposure, not a broken plugin. Press **交给智能体** / *Give to agents*, then confirm the Library MCP/router assignment for each desired agent. Manual endpoint: `http://127.0.0.1:3425/mcp/magpie/tools`.

## Writes

Writes are off by default. The non-secret Options example is `{"allowWrites": false}`. Enabling writes requires that option or `CAPY_ALLOW_WRITES=true`, and every write still needs `confirm:true`. Options are public policy, never credentials.

## Release and metadata

- `scripts/pack-release.ts` creates a stable top-level `magpie-capy/` folder and rewrites archive/gzip entry times to the real build clock or an explicit non-future `SOURCE_DATE_EPOCH`.
- The current 0.2.2 release archive is immutable. A standard 0.2.3 release package now exists with the normal npm root `package/` layout; install through the official Magpie CLI with the stable plugin ID, and once npm publication is available use standard npm installation. Do not manually load the unpacked package folder. The GitHub release is authorized; npm publication is still pending authentication, so npm availability is not claimed.
- For release 0.2.3, install through the official Magpie CLI with the stable plugin ID; once npm publication is available, use standard npm installation. Do not manually load the unpacked package folder. The GitHub release is authorized; npm publication is pending authentication, and no current npm availability is claimed. No OAuth support is claimed. CLI local logout clears the local credential but is not server-side revocation, and `CAPY_API_KEY` can override UI logout and keep tools authorized. The 0.2.3 GUI check passed only the subset above; GUI local logout and prompt cancel were not verified.
- Native local-folder version/license/date display may differ from npm registry cards and from browser timezone rendering. The manifest and archive improve what they can; host-native metadata remains a limit.
