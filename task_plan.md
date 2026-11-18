# RQ-REBASEDEDUPQ8

Goal: prevent duplicate active rebase jobs per PR, reconcile terminal PRs, and verify concurrency, restart recovery and failure retries. Leave changes uncommitted.

- [x] Read Phantom and repository guidance.
- [x] Locate scheduler, persistence and regression tests; check overlap.
- [x] Implement one coherent fix within the work-tier budget.
- [x] Run changed verification, typecheck, lint, docs checks and affected tests.
- [x] Write BRIDGE_NOTES.md with commands, counts and net LOC.

Errors: global Phantom install failed EPERM; existing phm 3.30.31 remains usable. Wire status exited 1 with inaccessible configuration paths; no auth/configuration changes attempted. Initial recovery test assumed native owner classification; sandbox denies ps, so it now proves both safe refusal modes and no queue write. Initial runs: 103/104 and 0/1; final affected run: 104/104.

Status: complete. Affected tests 104/104 and authority tests 10/10 passed; typecheck, docs and changed verification passed. Full lint failed on 9 pre-existing errors (269 warnings) in unchanged files; changed-file lint passed. Changes remain uncommitted.
