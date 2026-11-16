# RQ-PR-CLEAR-1B plan

Goal: audit conflicting Phantom PRs, preserve evidence for safe supersession, and leave an uncommitted handoff.

- [x] Read repository and gateway instructions; attempt required installation and discover available tools.
- [x] Inventory current PRs and classify confirmed conflicts using read-only tools.
- [x] Verify supersession evidence and prepare one ledger row per PR plus comment drafts.
- [x] Validate artifacts and write BRIDGE_NOTES.md with exact results and limitations.

Constraints: no commits, pushes, publication, external sends, or remote mutations without the required whole-run lease. Do not inspect prohibited authentication or private stores. Never infer supersession from filenames alone.

Errors: global npm installation returned EPERM; installed phm 3.30.24 is available. Shell access to ~/.ashlr-runs and GitHub CLI configuration returned Operation not permitted. Therefore the required shared lease and ledger destination are unavailable. Use workspace artifacts as an explicit incomplete handoff, never as a replacement lease.

Results: 341 open PRs, 311 mergeable=false and 30 mergeable=true. Nine source PRs have exact preservation proofs across 64 changed paths in newer open PRs. The other 302 conflicting PRs remain REVIEW_REQUIRED, not proven unique. Before/after open membership is unchanged at 341. No remote mutations.

Verification: dependency installation repaired missing tsgo and ESLint. Typecheck, documentation check, verify-changed and the offline audit validator passed. Selected existing tests: 99 passed, 9 failed in 2 files because localhost connections returned EPERM. The diagnostic reproduced loopback EPERM. Full lint remains running and is not counted as a pass.

Additional errors: the first attempt to parse a large pretty-printed comparison via tool stdout failed because the output was truncated; subsequently read only the small candidate subset, with no evidence lost. Process enumeration is blocked by the shell sandbox. Required wire status returned EPERM for editor configurations; no configuration modification was attempted.

Status: local audit handoff complete; operational objective blocked. Closures, lease acquisition, shared-ledger publication and recuts are incomplete due to host access restrictions. No approval request is needed or pending.
