# Bridge production metrics

Run `phm metrics prod --json` to read production evidence for the current
GitHub repository. Use `--repo OWNER/REPO` to select a repository explicitly. Repeat `--repo` to report several repositories. Use `--lane codex` to select a
lane and `--bridge-label LABEL` to change the bridge label (default: `bridge`).
A PR qualifies if it has that label or its head branch starts with `bridge/`.
Exactly one nonempty `lane:NAME` label selects its lane. Missing or ambiguous
lane labels produce `unknown`. Open and closed unmerged bridge PRs stay in the
denominator. The cohort covers all PRs returned by the paginated GitHub reads,
without a time window. No bridge PRs produces empty groups, not a 100% share.

The command uses the existing `gh` identity, without creating credentials.
GitHub access must already be commissioned through Locus for the account.
It performs only GitHub API reads and unauthenticated public registry GETs.
No local state, releases, deployments, tags or packages are changed.

Evidence advances through three stages:

1. `merged`: GitHub records a merge timestamp.
2. `released`: the merge commit is an ancestor of a non-draft, non-prerelease
   GitHub release tag. Each tag is resolved to a commit once, including annotated
   tags. Ancestry and manifests use that pinned commit. Dates and version-shaped
   tag names alone do not establish inclusion.
3. `published`: a public root `package.json` or `Cargo.toml` at that commit names
   an exact version present in npm or crates.io. Private npm packages and Cargo
   packages with `publish = false` do not establish publication. Yanked crates
   do not count. A match from either supported registry establishes publication.

The JSON schema has `schemaVersion: 1`, `denominator`, `bridgeLabel`, and a
`reports` array. Each repository contains per-PR `rows` and per-lane `groups`.
Groups expose `total`, `merged`, `released`, `published`, `releaseUnknown`,
`publicationUnknown`, and `productionShare`. Share is the fraction of all bridge
PRs in the group with positive publication evidence, in the range 0 to 1.
Unknown evidence remains in the denominator, so share is a confirmed lower bound.
A PR counts once even if several releases include it. Registry evidence is
reused within a repository report for PRs in the same release.

Unavailable release, tag, comparison, manifest or registry evidence is `unknown`,
never success. A missing exact registry version is `no`. Failure to read the PR
population exits 1 and emits no report; usage errors exit 2. Partial evidence
reports exit 0 with explicit unknown counts. Upstream error bodies are not printed.

This measures package publication, not deployment health. Repositories without
supported public root packages, workspace-inherited Cargo versions, and packages
only in monorepo subdirectories report unknown publication. Deployment-only
repositories need a separate deployment evidence source. Current GitHub and
registry visibility is an observation, not historical attestation: deleted
releases and unpublished packages can change a later report. Branch and label
classification reflects current PR metadata.

The ancestry check uses the [GitHub comparison API](https://docs.github.com/en/rest/commits/commits#compare-two-commits).
Package evidence uses [npm registry metadata](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
and the public crates.io version API.
