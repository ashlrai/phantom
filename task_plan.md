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

# Task Plan: RQ-ROUTER-JEV-1

## Goal
Ship an advisory, schema-validated router with local-first decisions, bounded escalation, deterministic fallback and dispatcher audit records. Leave changes uncommitted and under 20 files.

## Phases
- [x] Read repository and Phantom gateway instructions; install isolated CLI.
- [x] Inspect configuration and client contracts.
- [x] Implement typed routing and read-only dispatcher observation.
- [x] Add regression coverage and documentation.
- [ ] Run required checks and write BRIDGE_NOTES.md.

## Decisions Made
- Reuse existing Jev transport and its budget / kill controls.
- No launch behavior or live fleet installs change.

## Errors Encountered
- Global npm installation EPERM; installed successfully with /tmp/rq-router-jev-tools prefix.

## Status
Verifying implementation and dispatcher fixtures.

- Initial typecheck could not start (missing tsgo); npm run install:worktree restored dependencies.
- MCP doctor reported unavailable companion servers; wire/authority inspection was read-only. No gateway configuration or auth was changed.
# Ecosystem onboarding

- [x] Inspect Phantom gateway instructions and existing onboarding/companion contracts.
- [ ] Implement bounded, names-only detection and a bundle grant with per-capability wiring receipts.
- [ ] Expose the wizard through CLI and desktop settings; document commands.
- [ ] Run named hermetic tests, static checks and docs validation; write BRIDGE_NOTES.md.

Constraints: fewer than 20 files; no commits/pushes/publication; no TCC changes;
no credential values in reports or receipts; no implicit enrollment or spending.

Errors: initial exploratory searches included missing paths and overly broad output;
subsequent reads use exact paths. No source changes made during discovery.
