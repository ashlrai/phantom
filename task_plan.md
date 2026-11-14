# Task plan: Grok Bot routine offload

- [x] Inspect existing fleet surfaces and protected paths.
- [x] Implement file-backed drive stub, metrics and Mac job definitions.
- [x] Run fixture tests, typecheck, lint and docs checks; record qualification limits.
- [x] Write BRIDGE_NOTES.md with results and net LOC.

Status: implementation complete, full repository qualification unverified. No commit, push or publication is authorized.

Errors encountered: first fixture assertion counted transitions instead of unique jobs (corrected 5 to 4). Initial typecheck and lint could not start due to incomplete node_modules; reinstalling lockfile dependencies.

Fleet-watch: 13 timeouts repeated in isolation; a focused test against the untouched HEAD fleet implementation reproduced the same timeout. Temporary diagnostic files removed.

Parallel full typecheck/lint produced no further output for about ten minutes; interrupted both (exit 130) and restarted sequentially to reduce resource contention.

Sequential full lint also interrupted after more than five minutes without further output. Changed-file ESLint, strict core typecheck, both lint guards, docs and 54 focused tests passed.

---

# Shared capability-routed queue

## Goal
Replace enqueue-time lane binding with dispatch-time capability routing, preserving launch fences and security controls. Leave all work uncommitted.

## Phases
- [x] Read agent prerequisites and establish scope.
- [x] Trace queue producers, dispatch admission, hysteresis and tests; attempt duplicate check (remote access unavailable).
- [x] Implement shared requirements, routing, audit records and priority ordering.
- [x] Update queue documentation and agent indexes.
- [x] Run affected tests, verification, typecheck, lint and docs checks; write BRIDGE_NOTES.md.

## Errors encountered
- Global npm install refused EPERM in the configured global prefix; retry with isolated /tmp prefix.
- Phantom wire status exited 1 due to protected or unavailable editor configs. No auth/config changes attempted.
- Restored missing tsgo and ESLint dependencies with npm run install:worktree.
- Baseline replay reproduced two pre-existing Mac fixture failures; supplied missing admission evidence and corrected the stale claim-limit expectation without changing gates.
- Repository verification failed on existing authority roots/closure and CODEOWNERS drift. Snapshot regeneration is Mason-only under AGENTS.md.
- Full lint failed on three existing no-control-regex errors; separate real-IO guard reports 12 existing missing members. Changed-file lint and console synchronous-IO guard pass.
- Optional queue-api test failed on environment-refused loopback HTTP (EPERM); relevant named suites pass.

## Status
Complete source candidate with 223 TypeScript tests and 94 focused Mac tests passing. Typecheck, focused lint and docs pass. Full lint, the real-IO membership guard, authority drift and one optional HTTP suite retain unrelated failures. Security review and re-pin are required for live adoption; no installation or publication performed.
