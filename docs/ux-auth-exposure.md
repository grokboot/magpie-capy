# UX, auth and exposure

## Auth methods

- **API Key**: a masked prompt is followed by one bounded read-only `GET /api/v1/projects` check. The host saves the key only after success. `CAPY_API_KEY` remains compatible and takes precedence.
- **Browser OAuth/OIDC**: feature-gated and absent unless `CAPY_OAUTH_ISSUER`, `CAPY_OAUTH_CLIENT_ID`, and a loopback `CAPY_OAUTH_REDIRECT_URI` are configured. It uses OIDC discovery, S256 PKCE, state validation, a loopback callback, and `auth.refresh` via `refresh_token`. The label and docs say it is not a Capy official third-party client; Capy's `/api/v1` acceptance of that issuer/token is not verified by the public contract.

Capy's own desktop sign-in (Clerk → `capy://app/` → `clientJwt`/`sessionId` → `mintToken` with `rotatedJwt`) is statically confirmed. It is not exposed as an official plugin contract because a third-party client/redirect/audience registration is not public. Do not call the optional OAuth flow “Capy official web authorization”.

Multiple host accounts fail closed. Local logout removes only the local credential; it is not server-side revocation. `CAPY_API_KEY` can keep tools authorized after UI logout.

## Provider hooks and badge

`provider.models` reads the documented `GET /api/v1/models` and maps `id`, `name`, and `reasoningModes` (as variants). It does not invent context window, output limit, tool support, or model pricing. `auth.usage` reads the documented balance and period report; `null` is not rendered as 0.

Whether Magpie shows a `Provider` badge is host classification. Models are now real because Capy's public API documents a model catalog and model selection, not to force a badge. A `Tools` badge is still expected for the task tools. `Tools, hidden from agents` / `工具，已对智能体隐藏` is a host exposure setting; use **Give to agents** / **交给智能体** and confirm the MCP assignment. Manual endpoint: `http://127.0.0.1:3425/mcp/magpie/tools`.

## Usage display

Windows distinguish:

- remaining credit in USD (`balance`, with `display`);
- `unlimited` (display only, no numeric balance);
- no credit balance (`remainingDollars: null`, `unlimited: false`, display only);
- current-period total and billed USD from `GET /api/v1/usage` (display only; no fabricated entitlement denominator or used percent).

A failed balance read shows “quota unknown” and the reason; it never shows a fake zero. A failed period report leaves the balance visible and labels the period row unavailable.

## Writes and task proxy

Writes are off by default. The non-secret Options example is `{"allowWrites": false}`; enabling requires that option or `CAPY_ALLOW_WRITES=true`, and every write still needs `confirm:true`. `confirm` is a caller assertion, not a human-approval boundary.

`run_task` is an explicit task proxy, not a direct model API. It creates a thread, lists tasks, and observes the newest task for a bounded time. `complete` is true only after the task stream's own `done`; a timeout or empty task list stays false.

## Release and verification status

The 0.2.3 artifact and tag are unchanged. 0.3.0 is a new preview with 156 offline mock tests and typecheck passing. No live Capy auth/balance/model/task/write request was made in this implementation turn, so no live acceptance is claimed. GitHub installation is supported; npm publication is pending authentication. `Discover` labels the plugin **Unofficial**.
