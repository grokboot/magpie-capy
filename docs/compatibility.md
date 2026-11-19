# Compatibility and verification

This file separates local verification from live-service validation. It is not a claim that the unofficial plugin is reviewed, endorsed or production-certified by Capy or Magpie.

## Verified locally (0.3.0)

- Full offline unit/contract suite and typecheck pass. The suite covers dynamic model discovery, balance/period usage mapping, model selection, task lifecycle reads, `run_task`, bounded task/thread SSE, OAuth PKCE/discovery/loopback callback/cancel/refresh, auth races, multi-account fail-closed, redaction, write-default-off, redirects, timeouts and body limits.
- Contract fixture contains the public OpenAPI operations for models, usage balance/report, tasks and task stream; tests check methods, paths, query fields, request fields and required response fields.
- Package/archive regression uses synthetic data and a pinned `SOURCE_DATE_EPOCH`; no credential or network is required.

## Not verified in this turn

- No live Capy login, model catalog, balance, task, SSE, message or write request was made.
- No real Capy organization API Key or OAuth token was used.
- No host chat-completion request to `capy/<model>` was made. This version registers no provider models, so the host does not route chat to Capy's non-existent completion endpoint; `list_models` exposes the catalog and real work goes through `run_task`.
- Capy's `/api/v1` acceptance of an optional OAuth/OIDC issuer's token, and Capy's registration of a third-party client/redirect/audience, are not confirmed by the public contract. The plugin now checks the exchanged token with `GET /api/v1/projects` before returning success; that check is mock-tested, not live-tested.
- Before 0.3.0, 0.2.3 had a controlled live check of native API-key authorization and a read-only `list_projects` (HTTP 200, empty). Because the result was empty, subagent/SSE/message/write paths were not live-tested. That historical check does not cover the new model/usage/task paths.
- 0.2.3's GUI check covered name, icon, Chinese README, 10 tools, authorized status and `allowWrites=false` persistence. GUI local logout and prompt cancel were not verified. 0.3.0 has 17 tools and no new GUI acceptance is claimed.

## OAuth boundary

The optional browser method is a real public OIDC authorization-code + PKCE implementation with a loopback callback, refresh-token rotation, and a post-exchange `GET /api/v1/projects` check with the access token. It is not a Capy official third-party client. Capy's desktop Clerk → `capy://app/` → `mintToken`/`rotatedJwt` chain is statically confirmed, but this plugin does not read runtime session stores, reuse the Capy desktop scheme, or claim that the desktop session JWT is accepted by `/api/v1`.

## Public route and releases

GitHub installation uses the public repository route (`grokboot/magpie-capy`, root manifest, committed entry). npm publication is pending authentication; no npm availability is claimed. The 0.2.3 artifact/tag is immutable; 0.3.0 is a new preview. `Discover` labels the plugin **Unofficial**, and the actual app catalog must contain it before it can appear. Local-folder version/license metadata remains a host limitation.
