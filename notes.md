# Notes: Devin absorption

- Installed phm is available at /Users/masonwyatt/.local/bin/phm.
- Node reports v22.22.3.
- devin --help documents list --format json and --export [PATH]. Export occurs after turns, so it is not assumed to be a read-only historical export command.
- devin list --format json returned [] in the fresh job worktree. This result is scoped to that directory.
- os.stat on /Users/masonwyatt/.ashlr-runs and its queue/ready.tsv returned PermissionError, errno 1, Operation not permitted. Path.exists initially hid this failure as false; stat verified that absence is not established.
- No app internal database or credential file was read.
- phm wire status defaults to every editor and reads Codex configuration. Only the explicit Claude target is eligible under this task's hard limit.
- Source batch_sessions.py documents exclusive per-line .batched leases in queue/run. Their availability cannot be verified while fleet filesystem access is denied.
- Final deliverable: BRIDGE_NOTES.md plus a local fallback ledger if the required external ledger remains inaccessible.
- Sanctioned devin list --format json returned [] in all three queried directories: this worktree, /Users/masonwyatt/Projects/ashlrai/phantom, and /Users/masonwyatt. None establishes account-wide history since November 10.
- Official CLI reference confirms that devin list is directory-scoped and --export writes after each turn: https://docs.devin.ai/cli/reference/commands . No new turn was launched.
- gh pr list failed before contacting GitHub because /Users/masonwyatt/.config/gh/config.yml is inaccessible (EPERM). No merged-PR coverage was established.
- Direct os.open(O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW) of the required ledger returned PermissionError 1. No ledger data was written to the requested destination.
- Verified actions so far: 0 absorbed, 0 confirmed duplicates, 0 commits/pushes/publications. Eligible and total session counts remain unknown.
- phm devin list --all --json returned 4 local tracked task records, all created and last updated before November 10 (September 28 through October 1). Every record has sessionId=null. This is not a provider session export or evidence that later sessions do not exist.
- npm run check:docs passed. npm run typecheck failed before checking code because tsgo is unavailable. npm run lint failed because ESLint's ../lib/cli module is missing.
- The sanctioned dependency installer remained pending without progress and was interrupted (exit 130). The changed-file verifier backend tsc was interrupted; it must not be reported as an overall pass. Its file-selection and empty-test guards passed; ESLint preflight skipped for missing dependencies.
- git diff --check passed. A temporary-HOME Python check passed 3 artifact assertions, with 0 session rows in the local TSV. This provides no session completeness or deduplication evidence.
