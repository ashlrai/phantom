# RQ-DRAIN2-PH-42 triage

- PR 1072 SKIPPED: The compact adapter targets a pending generator contract, while main has a different changelog collector; reconciling the planner artifact contract needs owner judgment.
- PR 1061 SUPERSEDED: Main already implements bus threads, durable delivery and the fenced task board in docs/BUS-THREADS.md and src/core/fleet.
- PR 1058 SKIPPED: GitHub CLI authentication/configuration is inaccessible, so the production-evidence and publication checks cannot be validated against their intended identity.
- PR 1057 REWORKED: Ported the offline seven-repository Markdown generator and its regression fixtures, preserving main's separate collector and tests.
- PR 1050 SKIPPED: Main already parallelizes doctor tool probes, but the proposed cross-run version cache needs judgment about stale executable/version evidence.
- PR 1048 SKIPPED: Main has queue statistics, but the proposed console API and live graph are absent and their read-authority integration needs security judgment.
