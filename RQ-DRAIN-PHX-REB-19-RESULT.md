# RQ-DRAIN-PHX-REB-19 outcomes

All six PRs were open and matched the supplied heads at inspection on November 24, 2026. No commit, push, tag, publish, merge, close or comment was performed.

The final user instruction prohibits commits and publication. The connected GitHub tools support reads but expose no close/comment mutation. The installed gh client cannot read its configuration (operation not permitted). No credentials were copied or read to work around that restriction.

The requested handoff directory could not be created (operation not permitted), so this report is saved in the worktree.

| PR | Action | New head SHA | Check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [#7247](https://github.com/ashlrai/phantom/pull/7247) | blocked | `804fa9746815fa13e22cef74c9d25729ad9ce913` (unchanged) | Local patch: typecheck, 27 tests, verify-changed pass; hosted Vercel failure; required checks unknown | None: still open |
| [#7230](https://github.com/ashlrai/phantom/pull/7230) | blocked | `19f18690c010d9143221308ee23cbe1cf192208b` (unchanged) | No local code change required; hosted Vercel failure; required checks unknown | None: still open |
| [#7229](https://github.com/ashlrai/phantom/pull/7229) | blocked | `3ce0b1720292e21dbd436a7860ea3c3352326219` (unchanged) | No local code change required; hosted Vercel failure; required checks unknown | None: still open |
| [#7223](https://github.com/ashlrai/phantom/pull/7223) | blocked | `05670eda957438c1a08b372c4090472a9f6db32c` (unchanged) | No local code change required; hosted Vercel failure; required checks unknown | None: still open |
| [#7218](https://github.com/ashlrai/phantom/pull/7218) | blocked | `d6f869c2398bbd313df6a50a8a11cbd4404dd28d` (unchanged) | No local code change required; hosted Vercel failure; required checks unknown | None: still open |
| [#7214](https://github.com/ashlrai/phantom/pull/7214) | blocked | `d579a18aca12a3659b2dc28bb54c72956a33eff4` (unchanged) | No local code change required; hosted Vercel failure; required checks unknown | None: still open |

## Findings and pending actions

1. **#7247:** Keep open. #7234 already supplied identity-aware seat claim matching, but not the unique `claimsOwner` diagnostics. The uncommitted patch adds those diagnostics using the same snapshot as matching, keeps master's exact-label and lowercase fallback behavior, and adds three regression cases. No PR branch merge was committed; this is the remaining intent adapted to master for review.
2. **#7230:** Superseded. Merged [#7279](https://github.com/ashlrai/phantom/pull/7279) supplies both site-llms contribution links. Merged [#8133](https://github.com/ashlrai/phantom/pull/8133) supplies the PR-template link. [#7421](https://github.com/ashlrai/phantom/pull/7421) supplies the CONTRIBUTING entry point. Current CLI docs include dot-evidence, slack-trace --work-state and router outcomes; version pins have advanced. Intended close comment: “Superseded by https://github.com/ashlrai/phantom/pull/7279 and https://github.com/ashlrai/phantom/pull/8133; the remaining contribution guidance, CLI entries and newer version pins are already on master.”
3. **#7229:** Superseded by merged [#7666](https://github.com/ashlrai/phantom/pull/7666). Five of nine touched files match its merged tree exactly; the remaining files retain the board and add later loop-stage/release features. Intended close comment: “Superseded by https://github.com/ashlrai/phantom/pull/7666.”
4. **#7223:** Superseded by merged [#7654](https://github.com/ashlrai/phantom/pull/7654). All ten touched files are byte-identical to that merged tree. Intended close comment: “Superseded by https://github.com/ashlrai/phantom/pull/7654.”
5. **#7218:** Superseded by merged [#8047](https://github.com/ashlrai/phantom/pull/8047). The same reader and registration landed with tests, expired-reset staleness handling and reset time in text output. Intended close comment: “Superseded by https://github.com/ashlrai/phantom/pull/8047.”
6. **#7214:** Superseded by merged [#7421](https://github.com/ashlrai/phantom/pull/7421), including first-contribution guidance, npm ci, fork/origin setup, squash titles and conventional commit guidance. Intended close comment: “Superseded by https://github.com/ashlrai/phantom/pull/7421.”

Replacement PRs were independently verified as merged through the connected GitHub tool. Every merge-tree comparison reports conflicts; none was assumed equivalent solely from its tree hash.

## Validation

- Final bot-seat suite: 27 passed, 0 failed, including 3 added regression cases.
- Full backend and web typecheck: passed.
- Final verify-changed: passed, including changed-file ESLint, docs, quarantine, conflict markers, backend typecheck and authority checks on both worktree and current master (10 tests each).
- Full repository lint: failed with 16 errors and 265 warnings across unchanged repository files. Changed-file ESLint passed. Existing errors include no-undef in CI scripts and unused imports in CI tests.
- Existing hosted commit statuses report Vercel failure on all six heads. Merge Gate, secret-shape and clean-tree were not verified by the commit-status-only response and remain unknown.
- Source patch: 4 files, 95 added lines, 12 removed lines, net +83. Report files are additional, uncommitted documentation.
- toolsUsed: GitHub get_pr_info, GitHub get_commit_combined_status. No companion MCP tools called.
