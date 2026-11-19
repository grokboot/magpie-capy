# Research notes

This project was built from public documentation and synthetic tests. No live Capy API request or real credential was used during implementation. It is not an official Capy or Magpie project.

## Public sources

- Magpie plugin documentation: <https://usemagpie.ai/docs/plugins>
- Magpie community plugin examples and registry: <https://github.com/magpie-community/plugins>
- Capy API OpenAPI: <https://docs.capy.ai/openapi.json>
- Capy streaming: <https://docs.capy.ai/api-reference/streaming>
- Capy API quickstart: <https://docs.capy.ai/api-reference/quickstart>
- Capy subagents: <https://docs.capy.ai/subagents>
- Capy public favicon used for attribution: <https://capy.ai/favicon.svg>

## Findings

- Magpie's documented tool hook serves plugin tools through `/mcp/magpie/tools` as `<plugin>_<tool>`.
- Capy is a durable task platform with projects, threads, subagents, messages and SSE streams, not a model-inference API. A task-tool plugin is the correct shape; no completion endpoint or model ids are invented.
- The public OpenAPI documents projects, threads, messages, subagents and stream endpoints. The plugin implements a read-only subset plus three explicitly gated write tools.
- The public subagent list/transcript endpoints support observing the tree the desktop UI displays; the plugin does not copy desktop-local device, file, shell or window IPC behavior.
- Tool exposure is a Magpie host setting. `Hide from agents` and `Give to agents` persist independently of plugin code; the plugin does not override them.
- Magpie's GitHub-topic discovery route documents a repository tagged `magpie-plugin`, root `package.json`, committed entry file, and non-fork/non-archived requirement. GitHub search indexing alone does not make the plugin visible in Discover; the actual app catalog must contain it. Discovery is layered rather than a single ten-minute wait: the prebuilt GitHub catalog is preferred for 48 hours; if it is unavailable, lookup falls back to the client-cached topic query (about 10 minutes) or live GitHub. The curated registry is a separate recommended list that refreshes at most every 6 hours. The community registry route is separate and npm-oriented; this project does not require npm publication for the GitHub route.
- Local-folder detail derives some version/license/date metadata differently from npm registry entries. The release archive fixes its own entry timestamps, but native local-folder metadata remains a host limitation.

## Design decisions

1. Tool-only, non-model plugin with a zero-model auth namespace for the API key.
2. Fixed Capy API origin, no arbitrary base URL, redirects refused.
3. Environment key compatible, with host-auth sign-in preferred when no env key.
4. Strict runtime validation, bounded responses, bounded SSE, no automatic writes or retries.
5. Caller-owned idempotency tokens and default-off writes with a non-secret options example.
6. Public documentation and brand attribution kept separate from the MIT source license.
