# Findings

PR #3510 remains open, head 8fc8b46dfb5608100d011fc1e6bb8f092fe8c60e on masonwyatt23/phantom:codex-bridge/RQ-PHX-COSSELFTICKSTEP14. GitHub reports conflicts. Current master already contains dry-run COS work, path validation and CLI metadata. Remaining feature is the final COS self-tick stage and adapted tests. Preserve bus notices and all newer stages.

No companion tools called. GitHub connector used for read-only PR metadata. Remote update/CI/enqueue remain prohibited by the final no-push rule.

Verification findings:
- First focused run: 17 files passed, 2 failed; 152 tests passed, 3 failed. All 10 COS self-tick regressions passed.
- Additional full-tick/replay/Slack/report-reader run: 4 files, 34 tests passed.
- Docs check passed (0 errors).
- Authority verification: 8 passed, 2 failed (CODEOWNERS test timed out at its unchanged 30s limit; runtime closure grew by 12 files). New roots: none.
- Apps-boundary failures include three apps modules already in the baseline closure snapshot and the newly reached apps-recovery-glance.ts. The existing outcomes API test root reaches the pre-existing recovery modules; COS fleet facts adds the new glance path.
- Board-notify real dry-run test returns exit 1 even though its COS step is injected as an inert fake; no notifier implementation changes were made here.
- Initial full typecheck/lint could not start (missing tsgo and incomplete ESLint). Prescribed install:worktree succeeded and repaired dependencies; both checks were restarted.
- No protected snapshot regeneration, CODEOWNERS changes, workflow changes, remote writes or live installs.
- Full typecheck passed after dependency repair. Isolated CODEOWNERS rerun passed all 6 tests without a timeout. Board-notify reproduction confirms inbox-unavailable in its empty bus fixture, with every other stage stubbed.
- Non-mutating diagnostic errors: initial GitHub connector argument names rejected by schema and corrected; unmatched zsh test globs corrected with exact paths; ps is denied by the host; two guessed diagnostic filenames did not exist. No credentials were read or printed.
- Full lint finished with 3 errors and 273 warnings. Quiet JSON pass identifies only unchanged leader-reply-clean-original-238s.test.ts lines 74/99 and leader-status-reply.test.ts line 44 (no-control-regex). Zero changed files have ESLint errors. Real-I/O membership fails on 16 unchanged files; console-I/O guard passes.
