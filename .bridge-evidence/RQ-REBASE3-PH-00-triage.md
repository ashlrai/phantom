# RQ-REBASE3-PH-00 triage

- PR 3874 SUPERSEDED. `git diff origin/master pr-3874` (head `aead05a0d`)
  yields zero PR-side additions on all 21 touched files: fleet dep-gate,
  lane-model-drift, app-update API, GearTray update line and the five test
  suites are on master byte-for-byte. Master's registry/docs/types are
  strict supersets. No rework required.

- PR 3884 SUPERSEDED. Intent vs merge-base `56aeefffa` (head `4fde87a4f`):
  `FLEET_APPS` import move to `core/fleet/app-await.js` and the
  `fleet merge-delay` verb — both already on master. Residual diffs are
  stale base only (`--app` apps-status filtering and the mcp-native
  lazy-import refactor postdate the PR); merging would revert master work.
  No rework required.

- REWORKS_PR: 4017. Functional payload (precheck-repeats, sticky-loop,
  tests, registry) landed via #4058 (`556d71745`). Ported the four
  residuals missing from master: the `no-control-regex` eslint-disable in
  `src/cli/fleet-sticky-loop.ts` (master was failing `eslint .` on that
  line — verified 19:119 error before, clean after), README caption +
  companion-inventory row, AGENT-MCP-CLI probe caveat, and the COMPANIONS.md
  Ashlr Stack 0.3.6 row. Post-port worktree matches `pr-4017` on every
  touched file.

- GitHub CLI could not read `~/.config/gh` (sandbox EPERM); PR heads were
  fetched through Git (`refs/pull/N/head`) and metadata via the public
  api.github.com pulls endpoint.
