# PR 6547 local merge verification

Original head: `b9b3c376f56fbc33e8a3390de5b191751137f845`.
Merged master candidate: `2c2008f2611078ca36c73abd92517b79db55f45f`.
The merge is uncommitted. No commit, push, tag, publish or live install occurred.

## Resolution

The only merge conflict was the remote gateway read-route list. It retains all
current master routes, including the needs-Mason batch read, and the original
six exact Library GET routes. Master's mutation, step-up, authentication,
query-shape and deny rules are unchanged. Original phone Library behavior and
all auto-merged source hunks were reviewed.

The A5 followup patch remains byte-identical to the original PR and still passes
`git apply --check A5_LIBRARY_FOLLOWUP.patch`. The asks module and generated
status report remain byte-identical to master. Applying the patch was tried,
then reversed when it conflicted with the separate recovery suite's explicit
pending-followup contract. No asks test was changed.

Five historical Library qualification cases asserted pre-feature limitations:
oversized files disappeared and unavailability flags were ignored. They now
require exact metadata, empty content above the byte cap, the readable sibling,
distinct empty/unavailable results, explicit unavailable rendering, and refusal
of a malformed flag. Existing symlink, path, bounded-preview, malformed-response
and redaction checks remain. No test case was skipped or removed.

The touched MobileShell suite now waits for its real pending dynamic imports
inside React act before checking HomeGlance. This fixes a reproduced asynchronous
chunk-loading race without changing assertions or timeout budgets.

Independent review also found that a failed top-level Library query displayed
both unavailable and empty. The screen now displays unavailable without an empty
claim; a new regression verifies that result and keeps private diagnostic text
out of the UI.

## Commands and results

All tests used a fresh `TASK_TEST_HOME=$(mktemp -d)` followed by
`env HOME="$TASK_TEST_HOME"`; test and verification processes ran under
`nice -n 10`. Backend runs also set `ASHLR_VITEST_UNIT_MAX_WORKERS=1`.

- `git add src/core/web/remote-gateway-policy.ts`: marked the resolved conflict
  in the existing merge index. No commit created.
- `git apply --check A5_LIBRARY_FOLLOWUP.patch`: passed, including final check.
- `nice -n 10 npm run --silent dev -- fleet asks status --markdown`: failed
  because the shared tsx executable wrapper resolves a nonexistent scratch
  package store. Direct `node --import tsx src/cli/index.ts fleet asks status
  --markdown` succeeded. Generated output was restored to master with the
  reverted optional A5 change.
- `nice -n 10 npm run test:ci -- test/library-files.test.ts
  test/library-source-contract-qualification-522s.test.ts test/library.test.ts
  test/library-query-api.test.ts test/leader-attachment-list-api-119.test.ts
  test/leader-attachment-read-api.test.ts test/remote-gateway-fleet-routes-oct31.test.ts
  test/remote-gateway-policy-phone-routes-31.test.ts test/remote-gateway-auth.test.ts
  test/remote-gateway-policy-job-detail-nov01.test.ts
  test/remote-gateway-bus-read-session-nov01.test.ts
  test/remote-gateway-inbox-source-pin-nov1.test.ts test/fleet-asks-n17a.test.ts
  test/fleet-asks-owner-recovery-611s.test.ts`: initial 131 passed, 6 failed,
  14 files. Five failures were historical qualification expectations; one was
  the temporary optional A5 change.
- Rerun `npm run test:ci -- test/library-source-contract-qualification-522s.test.ts
  test/fleet-asks-owner-recovery-611s.test.ts`: 32 passed, 1 failed. The remaining
  failure was the new exact-cap preview assertion: the real sanitizer correctly
  returns `[REDACTED]` for the repeated-character fixture.
- Final `npm run test:ci -- test/library-source-contract-qualification-522s.test.ts`:
  23 passed, 0 failed. The assertion now requires that exact redaction. Across
  the final results of all focused backend files: 137 distinct tests passed.
- `nice -n 10 node node_modules/@typescript/native-preview/bin/tsgo --noEmit`:
  passed, exit 0.
- `nice -n 10 node node_modules/@typescript/native-preview/bin/tsgo --noEmit
  -p src/web-ui/tsconfig.json`: passed, exit 0.
- Changed-file ESLint used `nice -n 10 node node_modules/eslint/bin/eslint.js`
  with all 23 changed JS/TS paths selected by `git diff origin/master --name-only`:
  passed, exit 0. Final two edited test files were checked again: passed.
- Web command: `nice -n 10 node node_modules/vitest/vitest.mjs run
  --config vitest.config.web.ts --maxWorkers=1 --no-file-parallelism
  src/web-ui/routes/verse/mobile/screens/LibraryScreen.test.tsx
  src/web-ui/routes/verse/mobile/MobileShell.test.tsx
  src/web-ui/routes/verse/mobile/mobile-overflow.test.ts
  src/web-ui/routes/verse/library`.
  Initial run: 115 passed, 12 failed in MobileShell, 21 files total.
  A warm MobileShell-only rerun: 15 passed, 1 failed waiting for HomeGlance.
  Parent independently ran unchanged master MobileShell: 9 passed, 7 failed,
  including the same loading waits. Those parent counts are independent
  baseline evidence, not this candidate's results.
  After the deterministic import wait, MobileShell-only: 16 passed, 0 failed.
  Final full touched web run: 21 files, 127 passed, 0 failed. After the independent
  query-error repair, the affected LibraryScreen suite passed 7/7, including its
  new regression. All final focused web file results cover 128 distinct passing
  tests. The two files changed by that repair passed ESLint again.
- `nice -n 10 npm run check:docs`: passed, zero errors.
- `nice -n 10 node scripts/verify-changed.mjs`: run once on the uncommitted
  merge. Its merge-base selection includes 3,833 inherited master paths.
  Exit 1: 7 ESLint errors in inherited master files, 6 malformed
  inherited JSONL fixtures, 23 quarantine-ledger findings in inherited files,
  28 inherited real-I/O lane findings, and a broken relative tsgo shim. Both
  authority runs passed 10/10 tests; docs, conflict-marker and verse sync-I/O
  checks passed. Direct compiler entry points passed as recorded above. No gate
  was changed or bypassed. The full log is in the adjacent local verification
  artifact, not a public repository change.
  All 51 existing paths mentioned by that log were independently compared with
  origin/master and are byte-identical.
- `git diff origin/master --check`: passed.
- `git diff --name-only --diff-filter=U`: empty, zero unresolved merge entries.
- `git diff origin/master --name-only -- .github/CODEOWNERS src/core/authority
  test/fixtures/authority`: empty. No protected baseline changes were introduced.

## Final result

Local focused behavior checks pass: 137 distinct backend tests and 128 distinct
web tests, total 265. Both compiler projects, changed-file ESLint and docs pass.
The repository-wide merge-base gate remains blocked by inherited master findings
and the shared executable shim. Hosted checks and publication remain unverified.

Source and test delta against master before this report: 26 paths,
501 insertions, 115 deletions, net +386 lines.
This untracked report is additional and is not included in that source delta.
No hosted checks, merge queue, installed phone browser or release qualification
is claimed. Companion toolsUsed: [].
