# RQ-DRAIN-PHX-CLAIMNOTICE-TESTS

Outcome: uncommitted test repair. PR URL: none. Final task rules prohibit commits, pushes, tags and publication. No existing PR covering this repair was found in the required duplicate searches.

Updated ten claim-notice regression suites to the intended qualified acquisition key. Fixed the cross-repo bus-envelope lookup and stale snapshot-write failure count/reason. Added historical legacy-key and qualified-key restart coverage. Registered the 55-claim filesystem-heavy burst suite in the existing real-I/O lane. Assertions and shared timeout policy remain intact.

Compatibility decision: use the brief's permitted documented-resend option. Old three-field keys lack repo, owner and acquisition clock. Aliasing them could suppress distinct acquisitions. Historical discoveries still honor legacy keys; a fresh acquisition can enqueue once again after upgrade, then its qualified key fences further retries. No ledger rows or security fences changed.

Checks:
- Requested Vitest command with temporary HOME: PASS, 27 files, 117 passed, 1 pre-existing expected failure, 0 unexpected failures (118 tests total).
- Full typecheck: PASS backend and web.
- Final verify-changed: PASS, including authority drift (10 tests), changed-file ESLint, tsgo, quarantine and lane guards. Unchanged-file real-I/O findings are warnings here.
- Targeted ESLint: PASS.
- Documentation: PASS, 0 errors.
- Full lint: FAIL, 16 errors and 265 warnings in untouched files.
- Standalone real-I/O membership guard: FAIL for existing omissions in untouched files. Verse sync-I/O guard: PASS.

Handoff destination `/Users/masonwyatt/.ashlr-runs/handoff/RQ-DRAIN-PHX-CLAIMNOTICE-TESTS/RESULT.md` could not be created due to EPERM. This worktree copy is ready for the bridge to copy there.

Changed files:
- `test/claim-notice-cli-config-resume-494s.test.ts`
- `test/claim-notice-cli-kill-resume-494s.test.ts`
- `test/claim-notice-cross-repo-source-495s.test.ts`
- `test/claim-notice-durable-owner-restart-483s.test.ts`
- `test/claim-notice-ledger-recovery-438s.test.ts`
- `test/claim-notice-partial-batch-restart-485s.test.ts`
- `test/claim-notice-return-burst-490s.test.ts`
- `test/claim-notice-snapshot-health-563s.test.ts`
- `test/claim-notice-snapshot-write-replay-493s.test.ts`
- `test/claim-notice-team-fence-restart-495s.test.ts`
- `test/config/realio-lane-membership.mjs`
- `BRIDGE_NOTES.md`
- `RESULT.md`

Code/test diff: 59 insertions, 14 deletions, net +45 LOC across 11 files. Full commands, earlier failures and limitations are in BRIDGE_NOTES.md.

toolsUsed: [] (no companion domain tools called).

Overall diff including both handoff files: 171 insertions, 14 deletions, net +157 LOC across 13 files.
