# RQ-DRAIN-PHX-REB-14 outcomes

No PR was merged, updated or closed by this job. The final instruction prohibits commits, pushes, tags and publication. Connected GitHub tools expose reads only; gh fails before authentication because its configuration is inaccessible. The requested handoff directory could not be created (Operation not permitted), so this is the worktree-local fallback.

The table records actual outcomes, not proposed closures. Unchanged SHAs are shown because no new heads were created. The already-closed PR is marked with its observed supersession action.

| PR | Action | New head SHA (unchanged) | Check status at original head | Replacement URL |
| --- | --- | --- | --- | --- |
| #7515 | blocked | 4ca4bd3b4f63151371476c47bd0d9d9416061c5c | Merge Gate and Fast gate failed; secret scans succeeded | https://github.com/ashlrai/phantom/pull/8209 |
| #7509 | blocked | defae1889c9ca6835d60df130cc352234bdd2f36 | Merge Gate and Fast gate failed; secret scans succeeded | https://github.com/ashlrai/phantom/pull/8360 |
| #7496 | blocked | a3cf12f01a55786e93fbfa303c8271b68a8e2504 | Only CodeRabbit success observed; required gate not established | None, partial recoveries only |
| #7480 | closed-superseded (pre-existing, skipped) | 5ccf8f306b00894e0900be9bd3ef48b63574d6ff | Not evaluated after closed-state skip | https://github.com/ashlrai/phantom/pull/7509 |
| #7441 | blocked | 72cb24a7e62de116dec4525ba37b204af2273457 | Merge Gate and Fast gate failed; secret scans succeeded | None, partial recovery only |
| #7439 | blocked | dabbf4c1ae343b795b3e29754c7798cef4978fcf | Only neutral CodeRabbit observed; required gate not established | https://github.com/ashlrai/phantom/pull/8186 |

## Evidence and remaining work

- #7515: merged #8209 explicitly supersedes the original, preserves both test paths, corrects nonexistent CLI paths and registry enumeration, and replaces a tautological assertion with actual CLI output checks. Merge commit 9c9902800b1364f15fdb215777f9d407e789c45f is on master. Close the original; do not restore its obsolete test implementation.
- #7509: all four documentation paths already distinguish the required hosted fast gate from scheduled full suites. Merged #8360 records original #7509 coverage in AGENTS.md, CLAUDE.md, CONTRIBUTING.md and docs/AGENT-OPERATIONS.md. Its merge is f2504a0ea1bf5ea87055dd75c87895a6290cadb9. The source's punctuation-only change also has no remaining unique intent. Closure is pending because remote writes are unavailable.
- #7496: merged #8139 preserved the evidence reader and standalone fleet command; #8341 preserved the digest; #8489 added original-case evidence tests. Each is partial. Original `phm lanes adapt` routing/help and Asks-card creation are absent from current master. Preserve master's later evidence semantics when reconciling; do not close this PR as fully superseded. No repaired branch or patch is claimed.
- #7480: GitHub reports closed, unmerged, at the expected SHA. Its existing closure comment, dated 2026-11-24 08:10:25 UTC, identifies #7509 as the identical-patch replacement. Skipped as instructed.
- #7441: merged #8296 preserves the backend dispatch seam and assignment lane only. It explicitly defers CLI, help, generated reference, planner running count, map badge and original tests. Those remaining integrations need reconciliation with master's newer doctor, pool and offload command signature. No repaired branch or patch is claimed.
- #7439: merged #8186 preserves the entire skipped-job report, CLI, API, Pulse alert, Goals card and tests. Merge fc7ecf087ca0ba750056c771d98bb851559a40a0 is on master. Close the original instead of duplicating this recovery.

`git merge-tree --write-tree origin/master <head>` was run for all five open originals. All five report conflicts, including add/add conflicts against recovered modules and tests. None was treated as a clean tree-equality supersession. Supersession above uses source intent, master content and verified replacement PR metadata.

Baseline checks on the unchanged worktree: six preservation suites, 31 passed, zero failed. This does not establish green checks on any repaired PR, because no repair was applied. See BRIDGE_NOTES.md for commands and tooling limitations.

## Undelivered one-line PR comments

These are drafts only. No comment was posted.

- #7515: Superseded by https://github.com/ashlrai/phantom/pull/8209, which preserves and corrects both original help-test files.
- #7509: Superseded by https://github.com/ashlrai/phantom/pull/8360 and current master's CI documentation across all four original paths.
- #7496: Blocked: partial recoveries leave the lanes adapt and Asks integration unresolved, and this job prohibits commits and publication.
- #7441: Blocked: the CLI and map integrations remain outside the merged partial recovery, and this job prohibits commits and publication.
- #7439: Superseded by https://github.com/ashlrai/phantom/pull/8186, which preserves the complete skipped-job feature.
