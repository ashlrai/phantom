# Task plan: Grok Bot routine offload

## RQ-REBASE-PHANTOM-915

- [x] Inspect existing PR metadata, seven-file feature patch, and CI failure.
- [x] Apply the existing feature to fetched master afc979fd840de55c64233b1262f18a46c1c1d5bf.
- [x] Fix TS2322 without changing the custody aggregation rule; add overflow regression coverage.
- [x] Run focused tests, static checks, docs and authority checks; record broader failures.
- [x] Write BRIDGE_NOTES.md with exact commands, counts, net LOC and limitations.

Latest task RULES prohibit commits and pushes; clarification is pending. No new PR. All changes stay uncommitted.

Errors: global npm install denied (EPERM); gh config denied (EPERM); gateway wiring unavailable; shallow Git history has no merge base. Branch switch reached fetched master but upstream configuration write was denied. The feature patch applied cleanly using git apply --3way.

Validation: full typecheck, docs, changed-file verifier, nine custody-wrap tests and 13 authority/security tests pass. Full lint has three no-control-regex errors in unchanged tests. Expanded test run: 320 passed, six daemon failures; six-case diagnostics on both candidate and master pass five and reproduce only the environment-dependent PID-reuse failure. Two unchanged tests cannot create .env fixtures under this session's filesystem restrictions.

Authority regeneration added existing routing roots src/core/routing/role-lease.ts and src/core/routing/role-slots.ts, 41 existing closure paths and 31 missing test owners; no entries removed. The PR already adds custody-capture.ts to the closure and custody-wrap-receipt.test.ts to CODEOWNERS.

Additional errors: incomplete initial dependencies (missing tsgo/ESLint lib) repaired with npm run install:worktree; new test mock overrode touch lookup, corrected to intercept only Phantom discovery; authority drift repaired with the official regen. A concurrent fleet fetch replaced the shared shallow origin/master tip, causing a verifier merge-base failure; fetch --deepen=100 restored ancestry and the verifier then passed in the foreground.

Status: local handoff complete. Remote PR update, hosted green Merge Gate and enqueue remain incomplete because final task RULES prohibit commits/pushes, and gh config access is denied. Historical plan follows.

- [x] Inspect existing fleet surfaces and protected paths.
- [x] Implement file-backed drive stub, metrics and Mac job definitions.
- [x] Run fixture tests, typecheck, lint and docs checks; record qualification limits.
- [x] Write BRIDGE_NOTES.md with results and net LOC.

Status: implementation complete, full repository qualification unverified. No commit, push or publication is authorized.

Errors encountered: first fixture assertion counted transitions instead of unique jobs (corrected 5 to 4). Initial typecheck and lint could not start due to incomplete node_modules; reinstalling lockfile dependencies.

Fleet-watch: 13 timeouts repeated in isolation; a focused test against the untouched HEAD fleet implementation reproduced the same timeout. Temporary diagnostic files removed.

Parallel full typecheck/lint produced no further output for about ten minutes; interrupted both (exit 130) and restarted sequentially to reduce resource contention.

Sequential full lint also interrupted after more than five minutes without further output. Changed-file ESLint, strict core typecheck, both lint guards, docs and 54 focused tests passed.
