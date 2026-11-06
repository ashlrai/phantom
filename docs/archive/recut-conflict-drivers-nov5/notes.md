# Integration findings

- Initial HEAD cd22d72c6, branch codex-bridge/RQ-RECUT-MR-CONFLICT-DRIVERS-phantom-NOV5, clean.
- Existing resolver scripts/resolve-merge-conflicts.mjs absent; no resolver used.
- Entire enabled manual-commit; no checkpoint found on this branch.
- Independent read-only exploration compares needs/MCP and app recovery groups before selection.

- Selected nine: #3163 #3166 #3174 #3175 #3176 #3186 #3187 #3188 #3192; all exact heads unchanged, open/non-draft in refreshed public metadata.
- Public discussion review found bot refreshes only; host live claim storage unavailable (OS denied). No claim mutation performed.
- MCP/API tools are retained-evidence observations only. Existing auth, app action gate, kill switch and credential custody untouched.
- All unique incoming source/tests preserved. #3174 helper preexisted at exact blob cc72adc03f530767a018fa242aa39c430ce40878; #3175 delivery test preexisted at 9f1f6fa2989a448d0bae4ff5d64521c99dfb4383; unique MCP/stop behavior integrated.
- Incoming recovery-check test fixture corrected from async rejection of sync API to sync throw, typed availability and Array.isArray discrimination; no assertions removed.
- Integration fixes: trusted follow root, generic config errors for all new tools, wall deadline after read, UUID query identity/grouping (preserve event spelling), safe untrusted UUID type guard.
- Worktree installer restored missing ESLint and native typechecker through frozen pnpm 10.28.2, ignore-scripts; no manifest changes.
- Initial grouped MCP/API test 70 passed, 1 failed (unchanged 5000ms test timeout). Final grouped rerun needed after UUID changes/install restoration; no timeout changes.

- Final native backend typecheck (`node_modules/.bin/tsgo --noEmit`) PASS on frozen code after upstream refresh. Earlier classic tsc captured the pre-fix malformed-ID `.toLowerCase()` guard and reported that old AST; final warm typecheck launched to verify correction and web command.
- Exact upstream baseline diagnostics comparison: archive cd22d72, original watch a9374cea2fe838a6e2505a2c9afc29f95310d124 and unchanged diagnostics test 81f0944d49382191e7656b8dca44e159453534a1 fail the same two assertions. No test/deadline/production guard changes made. Baseline log /tmp/recut-main-baseline-diagnostics.log.

- Final `npm run typecheck` exit0 (backend and web); final native backend and web both exit0. Final MCP/API/security/docs18 modules169 cases passed; final extra watch/wait3 modules25 cases passed. Deduplicated affected coverage36 modules310 cases:308 pass,2 reproduced baseline diagnostics failures. Changed ESLint20 files passed; affected real-I/O guard, sync-I/O and docs checks pass. Full global real-I/O guard has28 identical pristine-baseline gaps; broad ESLint interrupted after17+minutes, source check used prescribed changed paths.
- Entire final status enabled/manual-commit; no commits, pushes, PR closures or publications made.
