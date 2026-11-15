# Public fleet version audit

Run from a Node 22.15+ checkout with dependencies installed:

```sh
node scripts/version-audit.mjs > version-drift.json
```

Exit status is 0 for aligned evidence, 1 for confirmed drift, and 2 for incomplete
evidence or invalid arguments. Incomplete reports can also contain confirmed
drift. JSON schema version 1 includes observation time, per-source URLs, source
status, package inventory, expected and actual versions, repair suggestions and
summary counts. `toolsUsed` is empty because all requests are anonymous public
GETs. No environment credentials, authenticated CLI, tokens or account tools are
used. Errors omit upstream response bodies.

The fleet is Phantom, Phantom Secrets, Locus, Lexicon, Stack, Cortex and ashlr-md,
as listed in [the toolchain guide](AGENT-TOOLCHAIN.md). Root package.json is
preferred, with Cargo.toml as fallback. Secrets and Locus additionally inspect
CLI and MCP crates and their npm wrappers. Cargo member versions inherit the
workspace version. Stack compares its published CLI, core and MCP packages,
using the CLI version rather than its private monorepo root version.
Other private application manifests are observed without querying registries.
This inventory covers product distribution packages, not every dependency or
example package. Extend it when a product adds a distribution channel.

The reference is the default-branch manifest version. Stable tags, non-draft
stable GitHub Releases and public npm latest or crates.io max_stable_version are
compared numerically, ignoring build metadata. Registry metadata must identify
the same GitHub repository; name collisions or missing ownership metadata remain
unverified rather than creating false drift. A manifest ahead of publication
is reported as drift for review, never as authorization to release. Prereleases
are excluded from stable comparisons; a prerelease manifest is incomplete.
Tags and releases paginate to 2,000 entries each; reaching that cap, HTTP failures,
missing sources and malformed responses produce incomplete evidence. Anonymous
GitHub rate limits can make a run incomplete. Retry later without adding tokens.
Each request has a 15 second deadline and a 2 MB body limit. Redirects are refused.

Website checks read the shared ashlr.ai developer-tools catalog. Only explicit
version badges in a repository-linked article or repository-specific JSON-LD
softwareVersion count. Ordinary prose, dependency versions and other product
cards cannot establish a match. Missing badges or unsupported markup remain
unknown. Badges compare against the latest stable GitHub Release.

The audit never changes repositories, opens PRs, tags or publishes. Its only
repair suggestions are documentation, badges and changelog review. Publication
mismatches require owner review, not an automatic version bump. A future writer
must independently enforce that file allowlist and use the normal protected PR
path. Nightly workflow wiring and publish.sh handoff belong to the owner; no
workflow or release configuration is part of this change.

Offline regression tests:

```sh
HOME=$(mktemp -d) npx vitest run test/version-audit.test.ts
```
