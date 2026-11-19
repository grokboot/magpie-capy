# Architecture

## Purpose

This project is a local Magpie tool plugin for Capy's public API. It deliberately does not implement a model provider. Capy schedules durable coding-agent work; it is not a chat-completion or model-inference API. The plugin exposes documented task-platform resources to agents through Magpie's MCP tools server.

## Magpie integration

- `index.ts` exports exactly one function, `CapyTools`. Magpie calls every function exported by the entry module as a plugin, so helper functions live in other modules.
- `src/tools.ts` builds the OpenCode-style `tool` hook object: `{ tool: { name: { description, args, execute } } }`.
- `args` is a JSON Schema object with `additionalProperties: false`. Magpie passes it to agents as the tool input schema.
- Magpie's plugin host does not validate plain JSON Schema arguments itself before `execute` in the inspected 0.1.4496 host, so every tool validates raw arguments again at runtime.
- Tool names are 48 characters or fewer. Magpie prefixes them with the plugin short name.
- The plugin function creates a client per invocation. This reads `CAPY_API_KEY` only when a tool is actually called, allowing the host to start without a key.

## Modules

| File | Responsibility |
| --- | --- |
| `index.ts` | Sole Magpie entry export |
| `src/tools.ts` | Tool schemas, descriptions, argument parsing, write guards |
| `src/client.ts` | Typed Capy client, response validation, bounded watch aggregation |
| `src/endpoints.ts` | Fixed API origin and exact documented paths/operation ids |
| `src/http.ts` | Combined abort/timeout control, bounded response reads |
| `src/sse.ts` | Streaming UTF-8 SSE parser with byte/event bounds |
| `src/validation.ts` | Shared strict argument validation |
| `src/config.ts` | Environment key, write opt-in, per-call confirmation |
| `src/errors.ts` | Safe error codes, status/tag mapping, retry metadata |

## API mapping

All paths and methods are taken from the Capy OpenAPI 3.1 document served at <https://docs.capy.ai/openapi.json> and verified by `test/contract.test.ts` against `test/fixtures/capy-openapi-subset.json`.

| Local method | Operation id | API |
| --- | --- | --- |
| `listProjects` | `projects.list` | `GET /api/v1/projects` |
| `listThreads` | `threads.list` | `GET /api/v1/threads` |
| `createThread` | `threads.create` | `POST /api/v1/threads` |
| `getThread` | `threads.get` | `GET /api/v1/threads/{threadId}` |
| `listMessages` | `messages.list` | `GET /api/v1/threads/{threadId}/messages` |
| `listSubagents` | `subagents.list` | `GET /api/v1/threads/{threadId}/subagents` |
| `listSubagentMessages` | `subagents.messages` | `GET /api/v1/subagents/{subagentId}/messages` |
| `sendMessage` | `messages.send` | `POST /api/v1/threads/{threadId}/message` |
| `interruptThread` | `messages.interrupt` | `POST /api/v1/threads/{threadId}/interrupt` |
| `watchThread` | `streams.thread` | `GET /api/v1/threads/{threadId}/stream` |

The client sends no undocumented body fields. Thread creation sends `requestId`, `projectId`, `message`, and optional `title`. Message sending sends `text`, required caller `clientKey`, and optional `delivery`. Interrupt has no request body. Subagent reads pass server cursors unchanged and require explicit `threadId` or `subagentId`.

The installed desktop app's thread view renders a subagent tree from server-provided parent/relation/path fields. The plugin reads only the public subagent endpoints and does not synthesize the tree or copy desktop IPC/device operations.

## Authentication and configuration

`CAPY_API_KEY` is read from the Magpie host environment. There is no automatic discovery and no key file. The key is normalized locally, rejected if malformed, and sent only as `Authorization: Bearer …` to the fixed origin.

`CAPY_ALLOW_WRITES` must be exactly `true` to enable the three write tools. Each write call additionally requires `confirm: true`. Missing confirmation is not treated as consent, even if the string `"true"` is supplied. `confirm: true` is a caller assertion, not a human-approval UI or an authorization boundary; approval policy belongs to the host/user.

## HTTP policy

- `new URL(path, "https://api.capy.ai")`, where paths are constants.
- `redirect: "manual"`; all 3xx responses become `redirect_refused`.
- `cache: "no-store"` and `credentials: "omit"`.
- One attempt per call. No retry loop.
- A combined abort controller links `ctx.abort` with a timer. Default request timeout is 20 seconds; the client rejects configured timeouts above 45 seconds.
- Successful bodies are read with an 8 MiB default cap. Error bodies use a 64 KiB cap only for allowlisted metadata.
- JSON responses are checked for the required fields used by the client. Unexpected shapes become `invalid_response`.

## Error mapping

`apiError` maps HTTP status and known `_tag` values to fixed messages. Only allowlisted tags are shown. The message never includes upstream `message`, request body, URL, or key. 429 responses parse `retry-after` (integer seconds) first and `retryAfterSeconds` from the body second; the value is exposed as `CapyError.retryAfterSeconds` and in the safe message. Mutating calls remain single-attempt.

## Bounded `watch_thread`

The client requests the documented SSE endpoint with `Accept: text/event-stream` and an optional `after` cursor. The parser:

- decodes streaming UTF-8 bytes, including characters split across chunks;
- handles LF, CRLF, and CRLF split across chunks;
- parses comments, `event`, `data`, `id`, `retry`, and multiline `data`;
- flushes decoder state at EOF and discards pending data or an incomplete final event, as required by the WHATWG SSE interpretation algorithm;
- ignores unknown event names but counts them;
- handles `status`, `transcript`, `run`, `turn`, `assistant`, `tool_call`, `task`, `subagent`, `heartbeat`, `error`, and `done`;
- stops at `done` or a remote error frame;
- caps observation at 40 seconds, 500 parsed frames, and 1 MiB of raw SSE bytes;
- keeps committed `transcript` entries separate from unsettled `previews`;
- removes an assistant or tool preview when its committed transcript entry arrives;
- clears unsettled previews at `run:end` and on a `dropped` turn;
- advances `lastEventId` only for a valid committed transcript frame with a valid 26-character cursor, not for unknown or malformed frames.

The result is a bounded summary: status, counts, run/turn totals, committed transcript entries, only outstanding live previews, last committed event id, and an `ended` reason. It does not claim persistent server-pushed MCP notifications. Cancellation closes the local reader only. A remote stop must be requested explicitly with `interrupt_thread`. Compatibility verification is recorded in `docs/compatibility.md`; no live Capy API request was tested.

## Pagination

`list_threads` returns the API page plus `cursor`. `list_messages` returns `items`, `cursor`, and `beforeCursor`. The plugin never loops to fetch additional pages and never drops cursors. Callers page explicitly with `cursor` → `after` or `beforeCursor` → `before`.

## Idempotency

- `create_thread` requires a caller-supplied `requestId` (1–191 safe token characters).
- `send_message` requires a caller-supplied `clientKey` (1–64 safe token characters), matching the documented deduplication control.
- The plugin never generates, mutates, or substitutes an idempotency token, including after timeouts or ambiguous failures. There are no automatic mutations retries.

## Testing

- `test/client.test.ts`: method shapes, auth header, fixed origin, pagination, writes, failures, redirects, timeout/abort, body bounds, no retry.
- `test/tools.test.ts`: entry export shape, tool schemas, runtime validation, read calls, write guards, idempotency preservation, no key leaks.
- `test/sse.test.ts`: CRLF split, UTF-8 split, multiline data, event/data/id/retry parsing, byte/event bounds, abort.
- `test/contract.test.ts`: endpoint methods/paths, query fields, request field subset, required response fields, 429 metadata against the OpenAPI fixture.
- `test/helpers.ts`: mocked fetch and SSE responses. Tests never use a real key or make network requests.

## Deliberate non-goals

No model registration, provider configuration, fake chat completions, Capy login/OAuth, credential discovery, generic proxy, background reconnect loop, unbounded transcript download, or remote repository publication. A future integration that makes Capy *use* Magpie BYOK is a separate concern and would require its own documented configuration format.
