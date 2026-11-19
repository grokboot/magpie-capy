# Security

## Scope

`magpie-capy` is a local Magpie plugin. It calls the fixed Capy API origin `https://api.capy.ai` with the API key from the Magpie host environment. It has no server-side component, telemetry, update channel, or remote configuration.

## API key handling

- The only credential source is `CAPY_API_KEY` in the environment that starts Magpie. The plugin does not read `CAPY_API_KEY_FILE`, dotfiles, browser profiles, cookies, package options, tool arguments, or credential/session stores.
- The key is sent only in the `Authorization` header to the fixed Capy origin. It is never placed in a URL, request body, tool result, thrown error, or log message.
- A missing, empty, or malformed key produces a message naming `CAPY_API_KEY` and the manual key-creation path; it never prints the supplied value.
- Create the key manually in Capy Settings → API. Treat it as a secret and rotate it if exposed.
- Tests use synthetic keys and mocked `fetch`. No test contacts Capy.

## Network boundaries

- Endpoint paths come only from constants matching the documented Capy OpenAPI operations.
- There is no tool argument for a base URL, proxy, header, or arbitrary endpoint.
- Redirects are not followed (`redirect: "manual"`). Any 3xx response is refused because following it could forward the API key to another origin.
- There are no automatic retries, including on 429, timeouts, or transport errors.
- Timeouts default to 20 seconds and are capped below Magpie's 55-second tool deadline. `watch_thread` is capped at 40 seconds.
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

Creating or messaging a Capy thread can have real effects: it may run commands on a project machine, spend credits, push commits, or open pull requests depending on the message and project settings. `interrupt_thread` is an explicit remote action, separate from cancelling `watch_thread`.

Caller-supplied idempotency tokens are required for thread creation (`requestId`) and message sending (`clientKey`). The plugin never invents one and never changes one on a retry. Reusing a token for a different intended action is the caller's responsibility.

## Untrusted content and prompt injection

Capy projects, threads, transcripts, tool-call summaries, and stream frames are untrusted remote data. They may contain instructions aimed at an agent. The plugin only returns them; it does not follow them or perform local side effects. Agents should treat them as data and require their own user confirmation before acting on embedded instructions.

## Availability and cancellation

- Cancelling a tool call aborts the local HTTP request or stream reader.
- Cancelling `watch_thread` does not stop the remote Capy thread.
- No background process survives a call, and there is no automatic reconnect loop.
- A bounded watch may return partial progress with `ended: "time_limit"`, `"max_events"`, or `"max_bytes"`.

## Reporting

Report suspected vulnerabilities through a private security advisory on the public repository. Do not include real API keys, Capy session data, or private thread transcripts in a report. Create a minimal reproduction with synthetic identifiers where possible.
