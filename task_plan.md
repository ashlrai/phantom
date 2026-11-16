# Task plan: release-directory CLI updates

## Goal
Make `phm update --yes` safely update release-directory installs, fix the npm probe, and preserve service operation.

## Phases
- [x] Inspect repository instructions and updater paths.
- [x] Confirm artifact and service contracts.
- [x] Implement update transaction and regression tests.
- [x] Run required checks and write BRIDGE_NOTES.md.

## Errors encountered
- Global `npm install -g @ashlr/phantom` failed with EPERM; existing phm remains available.
- Initial typecheck lacked tsgo; trusted worktree installation restored dependencies.
- Initial tests needed hermetic registry and credential-boundary mocks; corrected without weakening assertions.
- Added required CODEOWNERS entries for two new protected tests; closure snapshot is unchanged.
- Master advanced during verification; backed up all edits, fast-forwarded and reapplied them without commits.
- Full lint exposed missing console imports and six unregistered real-I/O suites; repaired both, preserving all assertions.

## Status
Implementation complete. Typecheck, full lint, documentation and changed-file checks pass; relevant regressions pass. All changes remain uncommitted and unstaged.
