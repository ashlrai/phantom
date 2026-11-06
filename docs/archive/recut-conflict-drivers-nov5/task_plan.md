# Task plan: conflict-driver integration continuation

Goal: consolidate unique product behavior from 8-16 related exact-head backlog PRs on refreshed upstream, uncommitted, with full source mapping.

- [x] Inspect clean worktree, memory registry, recent commits, Entire state and Phantom onramp.
- [x] Refresh upstream, exact PR metadata/refs and public ownership; selected nine recovery PRs.
- [x] Inspect original-base/upstream diffs and integrate nine selected PRs, preserving all unique source/tests.
- [x] Run focused behavioral tests (308 passed, 2 identical upstream failures), changed-file ESLint, native backend types, docs/security checks. Classic full typecheck and both native checks pass.
- [x] Audit preservation and write source mappings plus precise next needs/intake batch in BRIDGE_NOTES.md (verification results complete).

Constraints: no commit/push/close/publish/auth changes; no held release, FINALIZE/DESKTOP, teammate, Slack, guardian or newer live-owner overlap. Preserve security and tests. Canonical checkout untouched.

Errors: global npm install OS EPERM; gh host config and host claims denied (public API/git used); API quota exhausted after metadata collection; API import patch context conflict resolved semantically; an erroneous Node syntax check on a Python helper failed (helper had already run successfully). Resolver script absent at initial HEAD; installed phm wire status does not support documented verb. Entire resume reports no checkpoint on continuation branch.

Status: complete; nine PRs integrated uncommitted on 93af05a2c7b4938b6e3301dbab136fcd1cc32255. Full typecheck, affected lint/docs/security checks pass. 308 cases pass; 2 baseline cases and 28 baseline inventory gaps documented.

Baseline blockers: two unchanged diagnostics assertions and 28 unchanged real-I/O inventory gaps reproduced on pristine upstream. Full ESLint stopped after 17 minutes and replaced by prescribed changed-file lint (20 files pass). No test/security source weakened.
