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

# RQ-MUSE-WIRE-1 plan

## Goal
Route a bounded, explicitly light fleet slice through owner-scoped node leases, with honest completion evidence and no live dispatcher installation.

## Phases
- [x] Inspect repository instructions and installed Phantom commands.
- [x] Inventory existing work, node admission and restock integration.
- [x] Implement bounded light job admission and regression coverage.
- [x] Run affected tests, static checks and docs validation.
- [x] Write BRIDGE_NOTES.md with commands, outcomes and net LOC.

## Constraints
- Leave all changes uncommitted; no push, release or live machinery install.
- Reuse owner/capability/lease/slot checks; no credential transfer.
- Do not duplicate PR #5529's multi-Mac enrollment documentation.
- Report live completions only if actually observed.

## Errors encountered
- Global npm installation failed with EPERM; installed successfully under /tmp/rq-muse-phantom-cli.
- Installed node pool status is unavailable without configured pool access.
- GitHub CLI cannot read its host configuration (EPERM); PR overlap inspection limited to supplied context and public metadata.
- SSH to muse is refused by the execution environment; live completions remain unobserved.
- Initial dependency tree lacked tsgo and ESLint internals. Worktree pnpm install succeeded but shared package files remained incomplete; restoring with npm ci --ignore-scripts --no-audit --no-fund.
- Checks overlapped dependency repair; invalid partial runs will be repeated after installation settles.

## Status
Implementation and runbook complete; 86 backend tests, 51 Python tests and 10 authority tests pass. Full typecheck, docs, changed-file lint and final verify-changed gate pass. Full-repository lint was interrupted after roughly 15 minutes without output; live muse completions remain unobserved. Changes are uncommitted; no live adoption performed.

# Chief-of-staff planner — complete

- [x] Inspect Phantom tools, state producers and fleet contracts.
- [x] Implement bounded advisory core, injected CLI and schema documentation.
- [x] Pass 26 new tests, CLI integration, typechecks and changed-file gate.
- [x] Record full lint and existing boundary failures in BRIDGE_NOTES.md.
- Global install and initial worktree install failed; isolated install and dependency retry succeeded.
- Host queue/config access denied; no bypass. No commit, push or publication.
# Task plan: fleet outcome metrics

## Goal
Ship pure outcome rollups, bounded advisory policy suggestions, CLI reports and a weekly brief, with contracts and hermetic coverage. Leave changes uncommitted.

## Phases
- [x] Read repository workflow and inspect task overlap.
- [x] Inspect lifecycle writers, existing metrics and CLI routing.
- [x] Implement measurement, suggestions, weekly markdown and CLI.
- [x] Verify affected tests, static checks and docs; write BRIDGE_NOTES.md.

## Errors encountered
- Global Phantom update: EPERM; existing installed CLI remains usable.
- Wire status: inaccessible editor configs, exit 1; no config changes attempted.
- Work claim service: unavailable; supplied roster has no overlap.

## Status
Complete: 54 distinct tests and 3 CLI smoke checks passed; typecheck, changed-file ESLint, docs and authority checks passed. Full lint has 15 baseline errors/271 warnings in unchanged files; documented in BRIDGE_NOTES.md.

Verification findings: initial 11 hermetic tests passed. Dependencies repaired via npm run install:worktree; full checks restarted. verify-changed initially failed due shallow history. Upstream fetch refused a shared shallow.lock held by another process; no lock removed.

A final merge-time enrichment edit introduced one extra parenthesis; fixture tests and CLI smoke caught the parse error. Corrected and rerunning checks.


---

# Task Plan: Unified fleet visualization

## Goal
Deliver live compute and agent observability in the existing Fleet surface, with honest unknown/stale data, 2D/3D navigation and shared session details; leave changes uncommitted.

## Phases
- [x] Inspect agent instructions and CLI discovery.
- [x] Trace existing telemetry, sessions and fleet UI contracts.
- [x] Implement bounded read-only projection and visualization.
- [x] Run checks, regression tests and record walkthrough in BRIDGE_NOTES.md.

## Decisions
- Reuse existing Fleet surface and sources; add no rendering dependency.

## Errors
- Global npm install failed EPERM; retrying with isolated /tmp prefix.
- wire status reports unavailable client configurations; do not change auth/config.

## Status
Implementation and focused verification complete; repository-wide qualification blocked by existing failures. See BRIDGE_NOTES.md.

- Isolated CLI install succeeded. GitHub PR search could not read gh config (EPERM).
- verify-changed ran once and failed selecting files: HEAD has no merge-base with origin/master; use the supported gate --base HEAD for this uncommitted worktree.

Final verification notes: full lint has 13 untouched-file errors; archived HEAD reproduces first-paint budget failures. Slow remaining gate phases interrupted after known failures (130). A loaded map-only run timed out twice; rerun isolated without changing test timeouts. Browser harness URL typo corrected, then actual loopback refused EPERM. Baseline archive initially lacked core imports; complete archive built and reproduced budget failures.

Map interaction coverage was split into focused telemetry and navigation cases, preserving assertions and keeping the 5s timeout. All five map cases passed. Final combined serial batch follows a parallel timeout in the existing Company overview case.

Final result: 49 focused backend + 14 serial pool + 107 serial UI tests pass. Backend/web typecheck, changed-file ESLint, docs and web build pass. Full gate remains unqualified due to baseline failures; all changes left uncommitted.

---

# RQ-ORCH-LOOP-1

Goal: compose the existing company stack into a bounded, repeatable orchestration cycle; leave all changes uncommitted.

- [x] Inspect existing chief-of-staff, roster/memory, peer bus, metrics and owner-thread boundaries.
- [x] Implement the thin cycle and CLI, preserving advisory authority and existing transport gates.
- [x] Prove repeated cycles and refusal paths with hermetic fixtures; document CONTRACT.md.
- [x] Run affected tests, verify-changed, docs, typecheck/lint and gate; write BRIDGE_NOTES.md with counts and net LOC.

Decisions: preview by default; apply coordinates named peers and records an owner notice, never launches jobs or edits dispatcher policy. Existing dispatch owns execution.

Errors: global npm install failed EPERM; temporary-prefix install passed. Initial typecheck lacked tsgo; npm run install:worktree repaired it. MCP wiring reports host config access denied. Two exploratory rg globs had no matches; use explicit paths.

Status: implementation and verification finished. All 84 focused tests, final typecheck, changed-file lint, docs and authority checks pass. Full gate failed on existing lint/test/UI issues and host loopback EPERM; full counts and limitations are in BRIDGE_NOTES.md. Changes remain uncommitted.
