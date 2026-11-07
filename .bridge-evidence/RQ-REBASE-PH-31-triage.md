# RQ-REBASE-PH-31 — per-PR dispositions

Batch had 3 reworks (so this file is supplementary evidence for closers,
not a zero-rework triage PR). All changes uncommitted in the worktree;
see BRIDGE_NOTES.md for the full report.

| PR | Disposition | Evidence |
| --- | --- | --- |
| 1518 | SUPERSEDED — close-candidate | Feature landed via #1152; master's telemetry.ts/resources.ts strictly ahead (PR would remove verified-roots + processAttribution). |
| 1517 | REWORKED in this batch | `phm doctor merge-path` ported: 2 new src files, 3 new test files, wiring in doctor-init/help/AGENT-OPERATIONS. 8 tests pass. |
| 1514 | REWORKED (residual) | Doc intent landed via #3674; ported the 3 remaining test assertions into nodes-decision-docs.test.ts — they pass against master's doc. |
| 1511 | SUPERSEDED — close-candidate | Same drain item (…-1253) landed via #1496, evolved via #3442; master's pacing/* ahead (PaceSolver, input validation). |
| 1509 | PARTIAL — owner-judgment remainder | Ported the separable readiness feature (plugins --dry-run/stdin-TTY/idempotence, picker selectionFailure, 12-test suite). NOT ported: ~200-file stale diff deleting live features (ask status, autopilot, fleet subs), .github/** edits, test-suite deletions, stale audit doc, scratch files. |
| 1508 | SUPERSEDED — close-candidate | Hop-events/rollup landed via #1461+; master's observability files and hop-rollup tests exist in evolved form. |

Verification: tsc --noEmit clean, eslint on touched files clean,
check:docs 0 errors, 26/26 touched tests pass with temp HOME.
cli-help-no-side-effects has 11 failures pre-existing on master
(metrics idle/verify/repos*/checkpoint resume), unrelated to this batch.
