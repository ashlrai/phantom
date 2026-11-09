# RQ-REBASE-PH-38 triage

Compared with `master` at 220818affcb4b85dac7aeacd73c412d6959d20e1. No PR state was changed.

- PR 1074 SUPERSEDED: The audit, documentation and tests landed via RQ-DRAIN2-PH-41; the excluded planning files and generated point-in-time report are not product changes.
- PR 1073 SKIPPED: Retirement and catalog work landed, but the residual unused capability field and conflicting seat-routed pricing need owner judgment; see RQ-DRAIN2-PH-41.
- PR 1072 SKIPPED: The offline compact adapter targets a different generator contract from main's collector; choosing the planner artifact contract needs owner judgment, as recorded in RQ-DRAIN2-PH-42.
- PR 1061 SUPERSEDED: Main has the thread, durable delivery and fenced task-board implementation; see docs/BUS-THREADS.md and RQ-DRAIN2-PH-42.
- PR 1058 SKIPPED: The production metrics implementation is absent; its GitHub evidence reads could not be validated because this environment cannot access the GitHub CLI configuration. See RQ-DRAIN2-PH-42.
- PR 1057 SUPERSEDED: The offline generator and fixtures landed via RQ-DRAIN2-PH-42; main has expanded regression coverage.
