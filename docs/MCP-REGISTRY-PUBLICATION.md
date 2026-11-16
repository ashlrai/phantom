# Publish Phantom MCP Registry metadata

Discovery metadata for Registry server `io.github.ashlrai/phantom-secrets-mcp` is published from the [ashlrai/phantom-secrets](https://github.com/ashlrai/phantom-secrets) workflow `.github/workflows/publish-mcp-registry.yml`.

The workflow is [`.github/workflows/publish-mcp-registry.yml`](https://github.com/ashlrai/phantom-secrets/blob/master/.github/workflows/publish-mcp-registry.yml). It landed in [phantom-secrets #1461](https://github.com/ashlrai/phantom-secrets/pull/1461) (merge `7eac17a808bb034d26235ebb37cfc9aef5a8e380`). The helper is `.github/scripts/publish-mcp-registry.mjs` and the offline checks are `.github/tests/mcp-registry-publication.test.mjs`, both in that repository. The manifest is `mcp-registry/server.json`. The package name is `io.github.ashlrai/phantom-secrets-mcp`, the npm package is `phantom-secrets-mcp`, and the version is the manifest `version` field kept in parity with `npm-mcp/package.json`.

This repository no longer contains `.github/workflows/publish-phantom-registry.yml`, `.github/scripts/publish-phantom-registry.mjs`, or `.github/tests/mcp-registry-publication.test.mjs`. Phantom's own `server.json` remains the `io.github.ashlrai/phantom` manifest. Required checks, the secret-shape gate, signing, and release workflows are unchanged.
