# Update investigation

- Current channel detection uses node_modules versus everything else; release dirs become git installs.
- npm view currently has no cwd and a 10-second timeout.
- Mutating updates require resident service registration to be absent.
- No commits, pushes, live installs, or release configuration changes are authorized by this job.
- GitHub latest release uses asset `digest: sha256:...`, with no separate SHA256SUMS asset. Closed package profiles supply the exact tarball name and repository.
- Daemon install delegates only for an operator on macOS to the existing resident-start CLI, preserving signed grants and confirmation. No restart/activation gate is bypassed.
- Public registry metadata now uses an unauthenticated bounded HTTPS GET; npm install keeps the credential transport.
- First focused run: 105 passed, 9 failed. Two older test suites assumed unwrapped subprocess names and one still expected npm-view; corrected their mocks to isolate the updater boundary and use registry fetch fixtures.
- Initial typecheck failed because tsgo was missing. `npm run install:worktree` restored the trusted toolchain.
- Live public registry check succeeds and returns 3.30.33. An installed 3.30.35 now reports up to date rather than proposing a downgrade.
- Uncommitted edits were backed up to `/tmp/RQ-PHM-UPDATE-backup-p_ev_03t`, then reapplied after a fast-forward to `ac1b9238aa`. No commit or stash was created.
- Full lint ultimately passes with existing warnings. New suites have generated owner entries; no Tier-1 root or closure changes were introduced.
