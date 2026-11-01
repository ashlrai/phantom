# RQ-GRAPH-ROUTE-B

## Goal
Implement and verify per-pool concurrency floors and ceilings, leaving changes uncommitted for the bridge.

## Phases
- [x] Inspect clean branch, recent history, memory, Entire and protected paths.
- [x] Map configuration, backpressure and router admission; identify protected-path conflict.
- [ ] Implement bounded pool policy and regression tests.
- [x] Run baseline tests, typecheck, lint and documentation checks; review diff.
- [x] Write BRIDGE_NOTES.md with commands, counts and net LOC.

## Decisions
- Do not run publish.sh: explicit no commit/push/publish instruction controls the handoff.
- Preserve quota, readiness, grant and resource limits even below the requested floor.
- Tier-1 exception requested because CODEOWNERS protects requested backpressure.ts and router files; no protected edits while pending.

## Errors encountered
- Initial typecheck failed on a truncated installed TypeScript file; lint failed on missing installed ESLint files. Reinstalled lockfile dependencies using `npm ci --ignore-scripts --no-audit --no-fund`; no tracked dependency files changed. Rechecking both.
- Exact pool-floor test command exits 1: the requested test file does not exist on the baseline.

## Status
Blocked on explicit Tier-1 exception. Baseline 140 tests, typecheck, lint (206 existing warnings), and documentation checks pass after dependency repair. Implementation and acceptance remain incomplete. See BRIDGE_NOTES.md.

# RQ-PHX-RESETWINDOWPLAN31
- [x] Inspect origin/master and existing ledger/subscription reader.
- [x] Implement advisory planner, CLI and regression coverage.
- [x] Acceptance: 14 tests passed; targeted ESLint, docs and CLI help passed.
- [x] Record full-check limits and finalize bridge notes: full lint/typecheck terminated after prolonged silence under host load above 100; no full-green claim.
