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

---

# Task plan: RQ-REBASE-PHANTOM-3530

## Goal
Resolve PR #3530 against current master, verify the result, and report accurately. Leave all changes uncommitted under the final user rule unless clarified.

## Phases
- [x] Inspect instructions and PR state (open, conflicts).
- [x] Fetch current master and existing PR; resolve integration locally (retain current master; PR functionality already present).
- [x] Run typecheck, lint, docs and affected tests; record baseline lint failure and interrupted full lint.
- [x] Write BRIDGE_NOTES.md with results and remaining blockers.

## Decisions
- No commits, pushes, remote branch update or enqueue while final no-publish instruction applies. Clarification pending.
- Use the connected GitHub tool for metadata because gh cannot read its config.

## Errors
- Global npm install failed with EPERM on its configured prefix; existing phm 3.30.24 remains available.
- gh pr view failed: config.yml is inaccessible.
- phm wire status reports inaccessible client configurations; no configuration changed.
- First typecheck failed before checking (missing tsgo); lint failed before checking (incomplete ESLint lib). Running sanctioned npm run install:worktree to repair dependencies.
- Exploratory read used scripts/install-worktree.mjs; actual installer is scripts/worktree-install.mjs (read successfully).
- npm run install:worktree failed with the installer's scrubbed child-process error.
- Initial web suite: 3 passed, 1 timeout (5000 ms), on unchanged master under load >300. Retrying unchanged with default timeouts.
- ps was refused by host permissions; no process arguments or credentials read.
- Retried installWorktree through the sanctioned module with sanitized failure diagnostics; succeeded with pnpm 10.28.2. Full static checks restarted.
- Web retry with identical command/default timeout: 4/4 passed.
- Full lint retry remained silent for about ten minutes; interrupted (exit 130). Running ESLint on all 13 PR paths and both repository lint guards as focused fallback; full lint remains unverified.
- ESLint on all 13 PR paths passed. The real-I/O membership guard failed on 16 unrelated files already present on unchanged master; no unrelated scheduling edits made.

## Status
Local investigation complete. Current master contains the PR functionality and additional security fixes. No source changes needed. Typecheck, docs, scoped ESLint, console I/O guard and 89 focused tests passed. Baseline real-I/O guard failed; full lint interrupted after ten minutes. Remote PR unchanged and not enqueued under final no-publish rule; no DONE-ALREADY claim.
