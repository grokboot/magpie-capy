# Compatibility and verification

This file separates local verification from live-service validation. It is not a claim that the unofficial plugin is reviewed, endorsed or production-certified by Capy or Magpie.

## Verified locally

- Full unit and contract suite, typecheck, and release-archive regression pass in the development environment.
- Isolated Magpie CLI loading of the extracted 0.2.1 archive shows 10 tools named `magpie-capy_*`, a zero-model `capy` auth provider, and the expected provider row with a sign-in action.
- Desktop/Web UI acceptance on the extracted 0.2.1 artifact: brand icon, Chinese-first README/version/license, organization API-key dialog (opened and cancelled without a credential), and persisted `{"allowWrites":false}` Options state.
- Missing key, malformed key, multi-account fail-closed, auth race, redaction, write-default-off, redirect, timeout, cancellation and SSE-limit paths are covered with synthetic keys and mocked `fetch`.

## Not verified

- No real Capy organization API key was used.
- No live Capy project/thread/subagent/message/SSE request was made.
- No write tool was executed against Capy.
- No end-to-end authenticated Capy API success is claimed.
- The public repository exists and GitHub search indexes it. The GitHub `magpie-plugin` topic is an official unreviewed route, but it is not an immediate Discover guarantee: the actual app catalog must contain the plugin before it can appear, and no current Discover visibility is claimed. Catalog lookup prefers the prebuilt GitHub catalog for 48 hours; if it is unavailable, lookup falls back to a client-cached topic query (about 10 minutes) or live GitHub. The curated registry is a separate recommended list that refreshes at most every 6 hours.
- The 0.2.2 patch changes version metadata, docs, and tests only; no new GUI pass has been run for it. The 0.2.2 archive is immutable.
- The 0.2.3 release package uses the Capy display name and the standard npm root package layout. The 0.2.3 GUI check passed name, icon, Chinese README, 10 tools, authorized status, and Options `allowWrites=false` persistence; GUI local logout and prompt cancel were not verified, so this is not a complete GUI pass. The GitHub release is authorized; npm publication is pending authentication.
- There is no OAuth. The intended path is Capy web email login, then Settings to create an API Key, then explicit manual delegation by pasting the key into Magpie's native password input. The key is not read-only by type, has no scopes of its own, and permissions follow the principal. Use a dedicated read-only service user and an expiry such as 30 days where possible; no specific scope, principal mapping, or expiry metadata was verified.
- For release 0.2.3, install through the official Magpie CLI with the stable plugin ID; once npm publication is available, use standard npm installation. Do not manually load the unpacked package folder. The GitHub release is authorized; npm publication is pending authentication, and no current npm availability is claimed. Automated live verification covered basic native authorization and a read-only project list; because the result was empty, subagent, SSE, message, and write paths were not live-tested. The suite contains 117 tests. The 0.2.3 GUI check passed only the subset above; GUI local logout and prompt cancel were not verified.
- Native local-folder version/license metadata remains a host limitation; the package manifest cannot override every registry-derived field.

## Public route

The documented GitHub route for Magpie discovery is a public, non-fork, non-archived repository with `package.json` at the root and the `magpie-plugin` topic. The entry file is committed. npm publication is a separate route and is not required for the GitHub-topic route; npm metadata is prepared but no npm release exists. A standard npm tarball has a top-level `package/` directory, which is normal and does not make manual extracted-folder installation a stable path. See `docs/research.md`.
