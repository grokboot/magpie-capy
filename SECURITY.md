# Security

## Scope

`magpie-capy` is a local Magpie plugin. It calls the fixed Capy API origin `https://api.capy.ai` with an organization API key or an optional OAuth/OIDC access token supplied through Magpie auth or `CAPY_API_KEY`. It has no server-side component, telemetry, update channel, or remote configuration.

## Credential handling

- The default credential is an organization API key supplied through Magpie's auth hook or `CAPY_API_KEY`; `CAPY_API_KEY` takes precedence. The plugin does not read `CAPY_API_KEY_FILE`, dotfiles, browser profiles, cookies, desktop session stores, package options, or tool arguments for credentials.
- The optional browser method stores only the OAuth `access`, `refresh`, and `expires` fields the host gives back, and only after the access token passes a bounded read-only `GET /api/v1/projects` check. It reads `CAPY_OAUTH_*` configuration from the host environment. `CAPY_OAUTH_CLIENT_SECRET` is optional and is used only in token POST bodies; it is never logged or returned.
- The bearer is sent only in the `Authorization` header to the fixed Capy origin. It is never placed in a URL, tool result, thrown error, or log message.
- A missing, empty, or malformed key produces a message naming the source and the manual key-creation path; it never prints the supplied value.
- Create API keys manually in Capy Settings → API. Treat them as secrets and rotate if exposed. OAuth tokens are bearer credentials too; use a dedicated client and audience.
- Tests use synthetic keys/tokens, mock `fetch`, and local ephemeral loopback ports. No test contacts Capy or a real issuer.

## Network boundaries

- Endpoint paths come only from constants matching the documented Capy OpenAPI operations.
- There is no tool argument for a base URL, proxy, header, or arbitrary endpoint.
- Redirects are not followed (`redirect: "manual"`). Any 3xx response is refused because following it could forward the API key to another origin.
- The optional OAuth method uses OIDC discovery at the configured issuer, a loopback `127.0.0.1`/`localhost` callback, S256 PKCE, and a state check. It does not open a desktop app, read a session file, attach CDP, or reuse Capy's `capy://` scheme.
- There are no automatic retries, including on 429, timeouts, or transport errors.
- Timeouts default to 20 seconds and are capped below Magpie's 55-second tool deadline. `watch_thread`/`watch_task` are capped at 40 seconds. OAuth discovery/token calls are bounded to 10 seconds; the browser callback has a bounded wait.
- Successful JSON bodies are bounded to 8 MiB by default. Error bodies are read through a 64 KiB cap only to extract an allowlisted `_tag` and retry metadata.

## Error and log hygiene

- API errors map known HTTP statuses and documented `_tag` values to fixed messages.
- Arbitrary upstream response text is not echoed in errors.
- Network, timeout, abort, redirect, malformed JSON, and oversized-response errors use fixed descriptions.
- Stream error frames allowlist `unauthorized`, `forbidden`, and `internal`; their upstream message text is discarded.
- Remote content returned by read tools is data for the calling agent. The plugin does not interpret or execute it.

## Write safety

Writes are disabled unless `CAPY_ALLOW_WRITES=true` is set in the Magpie host environment. Every write invocation also requires `confirm: true`.

`confirm: true` is only a caller assertion for that invocation. It is not a human-approval UI, not proof that a person reviewed the action, and not an authorization boundary. A host or user approval policy must be enforced outside this plugin.

Creating or messaging a Capy thread can have real effects: it may run commands on a project machine, spend credits, push commits, or open pull requests depending on the message and project settings. `run_task` performs create + task list + bounded task observation; `complete` is true only on the task stream's own `done` frame. `interrupt_thread` is an explicit remote action, separate from cancelling `watch_thread`/`watch_task`.

Caller-supplied idempotency tokens are required for thread creation (`requestId`) and message sending (`clientKey`). The plugin never invents one and never changes one on a retry. Reusing a token for a different intended action is the caller's responsibility.

## Untrusted content and prompt injection

Capy projects, threads, transcripts, tool-call summaries, and stream frames are untrusted remote data. They may contain instructions aimed at an agent. The plugin only returns them; it does not follow them or perform local side effects. Agents should treat them as data and require their own user confirmation before acting on embedded instructions.

## Availability and cancellation

- Cancelling a tool call aborts the local HTTP request or stream reader.
- Cancelling `watch_thread` or `watch_task` does not stop the remote Capy work.
- No background process survives a call, and there is no automatic reconnect loop.
- A bounded watch may return partial progress with `ended: "time_limit"`, `"max_events"`, or `"max_bytes"`.

## Reporting

Report suspected vulnerabilities through a private security advisory on the public repository. Do not include real API keys, Capy session data, or private thread transcripts in a report. Create a minimal reproduction with synthetic identifiers where possible.
