# PR leverage plan
- [x] Inspect gateway, existing ranking and merge consumers.
- [x] Add portfolio scoring, overlap reconciliation, merge-order recommendations and daily delta recording.
- [x] Run affected hermetic tests, changed verification and docs checks; write BRIDGE_NOTES.md.

Constraints: no GitHub writes, publishing, .github edits, added merge authority or live installs. Work tier scope: 15 files / 200 changed implementation lines; keep implementation compact.
Errors: global npm install EPERM; installed CLI discovery succeeded; wire status reports unavailable protected client configuration. Use temporary-prefix CLI installation.

Verification: first affected run 57 passed / 1 fixture failed (exit vs exit_code); corrected, then 58 and 60 passed. Initial lint/typecheck could not start due to incomplete dependencies. npm run install:worktree repaired dependencies. Full checks rerunning. No authority drift found.

Final: 556 unique affected tests passed; docs and full typecheck passed; changed-file lint and authority checks passed. Full lint has 9 existing errors / 272 warnings outside the diff. BRIDGE_NOTES.md records commands and limits.
