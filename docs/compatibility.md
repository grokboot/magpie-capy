# Compatibility and verification

This file separates local verification from live-service validation. It is not a claim that the unofficial plugin is reviewed, endorsed or production-certified by Capy or Magpie.

## Verified locally

- Full unit and contract suite, typecheck, and release-archive regression pass in the development environment.
- Isolated Magpie CLI loading of the extracted 0.2.1 archive shows 10 tools named `magpie-capy_*`, a zero-model `capy` auth provider, and the expected provider row with a sign-in action.
- Parent desktop/Web UI acceptance on the extracted 0.2.1 artifact: brand icon, Chinese-first README/version/license, organization API-key dialog (opened and cancelled without a credential), and persisted `{"allowWrites":false}` Options state.
- Missing key, malformed key, multi-account fail-closed, auth race, redaction, write-default-off, redirect, timeout, cancellation and SSE-limit paths are covered with synthetic keys and mocked `fetch`.

## Not verified

- No real Capy organization API key was used.
- No live Capy project/thread/subagent/message/SSE request was made.
- No write tool was executed against Capy.
- No end-to-end authenticated Capy API success is claimed.
- GitHub discovery indexing is not verified until the public repository exists and is tagged. The official UI describes a roughly ten-minute cache.
- Native local-folder version/license metadata remains a host limitation; the package manifest cannot override every registry-derived field.

## Public route

The documented GitHub route for Magpie discovery is a public, non-fork, non-archived repository with `package.json` at the root and the `magpie-plugin` topic. The entry file is committed. npm publication is a separate route and is not required for the GitHub-topic route. See `docs/research.md`.
