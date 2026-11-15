# RQ-REBASE-PH-40 triage

Compared with master 220818affcb4b85dac7aeacd73c412d6959d20e1. No reworks were made; skipped items are not recommendations to close.

- PR 1028 SUPERSEDED — #1500 landed the approval card, decision API and tests; subsequent main changes extend that implementation.
- PR 1022 SKIPPED — the v1 local mailbox and top-level bus CLI are not present as such; main has a newer agent bus contract. Porting a separate transport without reconciling delivery, acknowledgment and authority semantics risks incompatible message stores. Needs bus-contract reconciliation.
- PR 1013 SKIPPED — #964 already provides a cycle collector, but this PR differs in job identity and event output; blindly adding a second sender could duplicate telemetry. Its remaining behavior needs reconciliation with the existing collector and consumers.
- PR 976 SKIPPED — fleet routing, spending and metered policy require owner judgment under the no-spending boundary; the historical change spans 81 files.
- PR 970 SKIPPED — includes publisher and leader launch code subject to Security GATES v3; #1420 landed a worktree follow-up, but the entire PR is not proven superseded.
- PR 948 SKIPPED — fleet routing, spending and metered policy require owner judgment; its own handoff records unresolved gates and a failed compatibility test.
