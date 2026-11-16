# Desktop automatic update plan

## Goal
Keep release discovery fresh on the shipped signed updater path, exercise a mock feed, and document the installation handoff.

## Phases
- [x] Inspect native updater, release publisher, installed bundle metadata and coordination.
- [x] Revalidate the discovery feed and cover repeated checks with a mock HTTP feed.
- [x] Document user-visible behavior and post-publish acceptance.
- [x] Run required checks and record results in BRIDGE_NOTES.md.

## Decisions
- Preserve signature verification, endpoint restrictions and host installation admission.
- Leave all changes uncommitted. Do not publish or operate pinned release scripts.
- Hold a coordination lease in /tmp/phantom-agent-work-leases because the default fleet store is unavailable.

## Errors encountered
- Required global npm install: EPERM in the configured global prefix. Existing phm used for discovery.
- Default coordination store: unavailable. Temporary shared coordination store acquired a one-hour lease.
- GitHub CLI: configuration access denied. Public GitHub HTTP: 403. Live feed and open PR status cannot be verified here.
- Follow-up: source CLI reached the release feed and verified 3.30.33 using the existing commissioned signature policy. Open PR metadata remains inaccessible.
- Wire status requires one target with --config; retried with an absent temporary config to avoid reading prohibited Codex paths.
- Initial typecheck failed because tsgo is missing; initial lint failed because ESLint's lib/cli is missing. Running the sanctioned worktree install to repair dependencies.
- Sanctioned worktree install completed, but shared ESLint still lacks apply-disable-directives. Trying an isolated exact-version ESLint install without editing shared package files.
- First backend run: 122 passed, 7 installer assertions failed with update-unavailable. Rerunning the failing suite after dependency repair.
- Installer retry: 62 passed, the same 7 failed. No backend installer implementation or test was changed.
- Web runs initially retained two stale expectations for the available-update copy. Both corrected; the focused reasons suite now passes all 3 cases, with the other 40 cases passing in the preceding run.
- Real-I/O lint inventory fails on three unchanged test files; console synchronous-I/O guard passes.
- Native library compiled; first mock-feed attempt hit OS denial of loopback connections (4 passed, 2 failed). Replaced socket transport with in-memory streaming HTTP responses while preserving all security assertions; final native client suite: 6 passed, 0 failed.
- verify-changed used its pre-install fallback compiler, timed out after 900 seconds and skipped web paths not yet edited. Independent full npm run typecheck passed after dependency repair.
- Isolated lint of the affected status model and tests passed.
- Native binary compiled; runtime handoff suite passed all 9 cases. Full ESLint finished with 15 errors in three unchanged files and 271 warnings. Native Clippy is in progress.

## Status
Source handoff complete. All affected native and web tests, full typecheck, documentation, formatting, native library Clippy and affected-file lint passed. Disposable fixtures removed. Repository-wide failures and installed-app acceptance remain documented in BRIDGE_NOTES.md. All changes are uncommitted.
