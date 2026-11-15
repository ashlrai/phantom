# Notes: PR #4053

Source: connected GitHub get_pr_info for ashlrai/phantom #4053.

- State open; merged false; mergeable false.
- Existing fork head: masonwyatt23/phantom, codex-bridge/RQ-REBASE-PH-12, 595a89ad36cc406277c64a039d37b487691ab9a0.
- Base branch master. Original PR includes 61 files, +68,068 / -73.
- Local initial HEAD 948871d409a; initial origin/master 6b1ad2fe888d66434e586fb77881c9f7931a0416.
- gh cannot read /Users/masonwyatt/.config/gh/config.yml (operation not permitted). Available GitHub connector tools only read.
- contrib/mac/publish.sh normally commits, pushes to codex-bridge/<job>, and creates a PR; running normal mode would violate this job's final rules and its existing-PR-only requirement.

## Local analysis and repair

- Shallow checkout: HEAD ancestry contains one commit; plain merge-tree exits 128 (unrelated histories in available graph).
- Fetch depth=2000 refused because shared phantom/.git/shallow.lock exists; lock preserved.
- Advisory explicit-parent merge-tree finds 31 conflict paths, recorded in conflicts.json. Original parent used as base; ancestry not independently verified.
- COS loop and agent profile/send-policy implementation already match PR blobs. Current docs sync is scripts/docs-sync.mjs with existing tests, different from the older CLI implementation. Empty suppression already exists in dispatcher, restock and precheck.
- GitHub connector returned no pull_request workflow runs for the old head; combined status returned only Vercel failure. Merge Gate is unverified.
- Baseline 5 suites: 37 tests passed, 1 failed. Failure is cos-decline-recutolde60 importing core fleet dispatcher without convention loaders.
- Local fix changes only that test import to fleet-entry.js, matching src/cli/index.ts and neighboring integration suites. All assertions preserved.
- ps is unavailable (operation not permitted); no shared processes or locks modified.
- After repair, 74 feature/dispatcher tests pass across seven suites. Boundary suite adds one pass and two failures due to the unchanged outcomes-api → verse-api → apps-recovery path. No related files or snapshot changed.
- npm run lint exits 2 because the installed ESLint is incomplete (missing ../lib/cli).
- Final verify-changed exits 1: authority drift 10/10 pass, TypeScript times out after 60 seconds, realio and verse lint pass. No full static-check success claimed.
