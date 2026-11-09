# RQ-DRAIN2-PH-29 triage

Compared with worktree HEAD 08d305f32b. PR #4024's evidence explicitly skipped three proposals, although a later sweep closed them as superseded. Those closures do not establish feature coverage.

- PR 1727 SKIPPED: web-triggered daemon installation conflicts with the signed repair authority boundary; security judgment is required.
- PR 1726 SKIPPED: local-model opt-in conflicts with existing automatic Connect probes and balancer semantics; the intended behavior requires clarification.
- PR 1725 SUPERSEDED: merged PR #3895 ported advisory lane ranking, CLI, and tests; later changes extend ranking.
- PR 1724 SUPERSEDED: merged PR #3895 ported both routing observation commands and documentation.
- PR 1723 SUPERSEDED: merged PR #3895 ported the resource ledger projection and tests.
- PR 1720 SKIPPED: historical local-lane policy applicability needs owner judgment; live restock deployment also requires Security re-pinning.
