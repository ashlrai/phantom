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


# Task Plan: RQ-REBASE-PHANTOM-976

## Goal
Prepare the existing PR #976 against master, fix affected checks, and leave all changes uncommitted under the final job rules unless the owner clarifies otherwise. Never create a replacement PR.

## Phases
- [x] Inspect job rules, gateway instructions and PR metadata.
- [x] Restore enough history and inspect the actual merge conflicts.
- [x] Resolve conflicts while preserving current master and the PR intent.
- [x] Run required local checks and affected tests; write BRIDGE_NOTES.md (remaining blockers documented).

## Errors Encountered
- gh pr view cannot read ~/.config/gh/config.yml (operation not permitted); the connected GitHub tool verified PR #976 is open.
- Global Phantom install failed with EPERM; isolated-prefix install is in progress. Existing Phantom 3.30.24 can run the agent registry.
- Checkout is shallow and has no local merge base with the PR head; read-only fetch is in progress.

## Status
Resolved the three-way conflicts using the GitHub-verified merge base; running static checks and affected tests. No commits or publication.

Bootstrap follow-up: isolated install succeeded (Phantom 3.30.31). Shared history fetch failed on an existing shallow.lock; did not remove it. Typecheck could not start because tsgo is absent; trusted worktree dependency repair started. Initial conflict extraction used an overly broad regular expression; corrected from original merge-tree blobs before validation.


## Final verification findings
- Full backend/web typecheck and a final backend recheck pass after npm ci repaired incomplete dependencies.
- Documentation links, final changed-file ESLint, console synchronous-I/O guard and pinned secret-shape scan pass (0 blocked, 4 allowed explicit fake fixtures).
- CODEOWNERS regenerated with four added protected tests; normal CODEOWNERS tests pass (6/6).
- Final five-module verification: 67 passed, 2 failed; only the protected Tier-1 closure assertions remain. Snapshot regeneration stays reserved for Mason under docs/TIER1-WHY.md.
- Current coordination entry tests pass (15/15) after routing the test through fleet-entry.ts.
- Broad verification: 268 passed, 18 failed initially; 3 CLI discovery failures and 1 coordination entry failure were fixed and rerun. The other 14 are loopback EPERM in remote gateway tests.
- Full lint completed: 3 pre-existing regex errors in two untouched reply tests and 273 warnings. All 57 changed code files pass ESLint. The separately run real-I/O guard found 16 pre-existing missing lane registrations outside this PR.
- Publication/enqueue not attempted: final user rule forbids commits/pushes, gh config access is denied, and protected closure review remains outstanding.

Status: local integration and verification complete with documented failures. Existing PR remains open and unchanged; publication/enqueue blocked under final job rules and protected closure policy.
