# Agent identity plan
- [x] Inspect roster, memory, orchestration and contracts.
- [x] Extend persistent metadata and add evidence-derived identity view.
- [x] Test lifecycle, attribution, missing evidence and compatibility.
- [x] Run required checks and write BRIDGE_NOTES.md.

Muse spec access blocked by OS; accessible copy requested, not received. Implemented the explicit task's bounded identity slice; conformance to unseen spec remains unverified.
Global npm install EPERM; existing phm used. Wire status EPERM for protected client configuration. No client configuration changes.
Initial ESLint module missing and initial tsgo lookup failed; repaired with npm run install:worktree. Subsequent lint and typechecks pass.
verify-changed failed existing resource-live Tier-1 closure drift; reproduced from untouched HEAD archive. Protected snapshot untouched.
Baseline archive's npx wrapper initially failed due relative pnpm path; direct absolute vitest entry point succeeded. An initial /tmp lookup did not follow the macOS symlink and reran the worktree closure test; corrected to /private/tmp for baseline confirmation.

# Plan: yield-based tier selection

- [x] Read repository instructions and attempt Phantom discovery.
- [x] Trace tier selection, capacity evidence and status output.
- [x] Implement a bounded work-to-frontier upgrade with regression coverage.
- [x] Run verification and write BRIDGE_NOTES.md; leave all changes uncommitted.

Constraints: at most 200 implementation/test/doc changed lines; held lanes and zero-paid policy remain authoritative; no live installs.

Errors: global npm install failed with EPERM; installed phm 3.30.31 is available. Gateway status cannot read Codex configuration (EPERM).
Initial full checks found incomplete dependencies (missing tsgo and ESLint module); repaired with `npm run install:worktree`. Typechecks, docs and the two route-explain tests pass.
The expanded test run exposed a stale fixture only one second beyond the cutoff, which tick startup could invalidate; changed its synthetic timestamp to one hour old.
Final focused tests: 4/4 pass. Broad run: 122/123 passed before the fixture correction. Full lint reports 9 errors in three unchanged GitHub files. Progress-only `ps` was denied by host policy.
