# UX, auth and exposure

## Auth

Capy documents organization API keys. This plugin does not implement OAuth, device login, browser/session reuse, or credential discovery.

The real Magpie auth hook uses provider id `capy`, one `type: "api"` method labelled `配置 Capy 组织 API Key`, a zero-model provider namespace and a `provider.models` callback. The Provider badge is Magpie's auth namespace only: there are no models and no inference path. Tools are a separate MCP tool server.

Magpie stores the key in its own `plugin-auth.json`; the plugin only caches it in host-process memory. `provider.models` performs one read-only `GET /api/v1/projects` verification. `auth.usage` reports configured, verified, unverified, malformed and expired states. `CAPY_API_KEY` remains supported and takes precedence; the status names the actual tool source. Multiple host accounts fail tools closed rather than selecting an arbitrary account. A 401 clears tool use, while the host credential remains available for deliberate re-login.

`client.auth.get` is not a supported Magpie client method; only `auth.set/remove` and `getAuth` callbacks are used.

## Exposure

`工具，已对智能体隐藏` / *Tools, hidden from agents* is host-controlled exposure, not a broken plugin. Press **交给智能体** / *Give to agents*, then confirm the Library MCP/router assignment for each desired agent. Manual endpoint: `http://127.0.0.1:3425/mcp/magpie/tools`.

## Writes

Writes are off by default. The non-secret Options example is `{"allowWrites": false}`. Enabling writes requires that option or `CAPY_ALLOW_WRITES=true`, and every write still needs `confirm:true`. Options are public policy, never credentials.

## Release and metadata

- `scripts/pack-release.ts` creates a stable top-level `magpie-capy/` folder and rewrites archive/gzip entry times to the real build clock or an explicit non-future `SOURCE_DATE_EPOCH`.
- The current archive is `magpie-capy-0.2.2.tgz`; the immutable `v0.2.1` archive and the older 0.2/0.1 artifacts are preserved separately outside the public repo.
- Native local-folder version/license/date display may differ from npm registry cards and from browser timezone rendering. The manifest and archive improve what they can; host-native metadata remains a limit.
