# Architecture

## Purpose

`magpie-capy` is a local Magpie plugin for Capy's public task platform. It is not a chat-completion endpoint and does not claim Capy is an inference API. It exposes Capy task tools plus the host provider hooks for dynamic model discovery and real credit usage.

## Modules

| File | Responsibility |
| --- | --- |
| `index.ts` | Sole Magpie entry export: tools plus auth/provider hooks |
| `src/tools.ts` | Tool schemas, task/model arguments, write guards, `run_task` proxy |
| `src/client.ts` | Typed public-API client, strict response validation, bounded SSE |
| `src/endpoints.ts` | Fixed origin and exact documented paths/operation ids |
| `src/auth.ts` | API Key + optional OAuth credential state, models/usage hooks |
| `src/oauth.ts` | Feature-gated OIDC discovery, S256 PKCE, loopback callback, refresh |
| `src/usage.ts` | Pure balance/period report → host usage windows |
| `src/http.ts` | Abort/timeout control and bounded body reads |
| `src/sse.ts` | Bounded UTF-8 SSE parser |
| `src/validation.ts` | Strict argument and model-selection parsing |
| `src/config.ts` | Env key, write opt-in, confirmation |
| `src/errors.ts` | Safe error codes and status/tag mapping |

## Public API mapping

All paths are from the Capy OpenAPI 3.1 document and checked by `test/contract.test.ts` against `test/fixtures/capy-openapi-subset.json`.

| Local method | Operation | API |
| --- | --- | --- |
| `listProjects` | `projects.list` | `GET /api/v1/projects` |
| `listModels` | `models.list` | `GET /api/v1/models` |
| `getUsageBalance` | `usage.balance` | `GET /api/v1/usage/balance` |
| `getUsageReport` | `usage.get` | `GET /api/v1/usage` |
| `listThreads` | `threads.list` | `GET /api/v1/threads` |
| `createThread` | `threads.create` | `POST /api/v1/threads` |
| `getThread` | `threads.get` | `GET /api/v1/threads/{threadId}` |
| `listMessages` | `messages.list` | `GET /api/v1/threads/{threadId}/messages` |
| `listSubagents` | `subagents.list` | `GET /api/v1/threads/{threadId}/subagents` |
| `listSubagentMessages` | `subagents.messages` | `GET /api/v1/subagents/{subagentId}/messages` |
| `sendMessage` | `messages.send` | `POST /api/v1/threads/{threadId}/message` |
| `interruptThread` | `messages.interrupt` | `POST /api/v1/threads/{threadId}/interrupt` |
| `watchThread` | `streams.thread` | `GET /api/v1/threads/{threadId}/stream` |
| `listTasks` | `tasks.list` | `GET /api/v1/threads/{threadId}/tasks` |
| `getTask` | `tasks.get` | `GET /api/v1/tasks/{taskId}` |
| `listTaskMessages` | `tasks.messages` | `GET /api/v1/tasks/{taskId}/messages` |
| `watchTask` | `streams.task` | `GET /api/v1/tasks/{taskId}/stream` |

`create_thread`, `send_message`, and `run_task` send the documented `model` object (`modelId`, optional `reasoningMode`/`modes`). Omitting it leaves Capy's documented default chain in charge.

## Provider hooks

- `provider.models` calls `GET /api/v1/models` per account, caches for 5 minutes, and maps only documented fields. It does not invent context windows, output limits, tool support, or a Provider badge.
- `auth.usage` reads `GET /api/v1/usage/balance`, then the current subscription period's `GET /api/v1/usage`. `remainingDollars` is a remaining USD credit amount; `unlimited` and `null` (no credit balance) stay distinct. The period report has no entitlement denominator, so it is display-only rather than a fabricated used-percent. Failures say the balance is unknown and why.

## Authentication

The default method is an organization API Key with a masked prompt; `authorize` performs one bounded read-only project-list call before the host persists it. The key is only sent as a bearer to `https://api.capy.ai`.

An optional browser method appears only when `CAPY_OAUTH_ISSUER`, `CAPY_OAUTH_CLIENT_ID`, and a loopback `CAPY_OAUTH_REDIRECT_URI` are set. It runs OIDC discovery, S256 PKCE, state validation, a loopback callback, code exchange, and refresh_token rotation. It is explicitly not a Capy official third-party client; Capy's acceptance of the issuer's token is not verified by the public contract. Capy's own desktop Clerk → `capy://app/` → mintToken chain is statically confirmed but not implemented as this plugin's contract.

`CAPY_API_KEY` still overrides host auth. Multiple host accounts fail closed. Local logout removes the local credential only; it is not server-side revocation.

## Writes and task proxy

Writes are off by default and require both `allowWrites`/`CAPY_ALLOW_WRITES=true` and caller `confirm:true`. Caller-supplied `requestId`/`clientKey` are preserved verbatim; no automatic retry.

`run_task` is an explicit proxy: create thread (optional model) → list tasks for it → observe the newest task for a bounded time. `complete` is true only when the task stream emits its own `done` frame. A timeout or empty task list leaves `complete:false`; this is not a failure or completion claim.

## HTTP and validation

Fixed origin, `redirect: "manual"`, `cache: "no-store"`, `credentials: "omit"`, one attempt per call. Requests default to a 20 s timeout (max 45 s), successful bodies to 8 MiB, error bodies to 64 KiB. SSE observation is bounded by time, frame count, and 1 MiB. Runtime validation repeats argument/ID/cursor checks and rejects unknown fields.

## Deliberate non-goals

No fabricated chat-completion endpoint, model context/tool metadata, zero balance, entitlement/used-percent, or completion state. No private desktop IPC, session-store scraping, CDP/GUI control, device credential reuse, or claim that the optional OAuth token is a Capy official delegation until that is verified.
