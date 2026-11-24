# RQ-DRAIN-PHX-REB-12 outcomes

All six PRs were checked in the requested order and rechecked after preparation.
All remain open at the supplied heads. No remote mutation occurred. No new head
SHA exists: the table repeats the verified unchanged head, rather than inventing
an unpublished commit. Actions are `blocked`, never `closed-superseded` or
`merged-main`, because neither remote outcome occurred.

The final task rules prohibit commits, pushes, tags and publishing. The connected
GitHub tools expose reads but no close/comment operation; `gh pr view` failed
because its configuration was inaccessible. No credentials were read or copied.
The requested host handoff directory rejected creation with EPERM; this worktree
copy is the fallback. No authority baseline, closure allowlist, CODEOWNERS,
security control, workflow or live installation was changed.

| PR | Action | New head SHA (unchanged) | Check status / blocker | Replacement evidence (not closed) |
| --- | --- | --- | --- | --- |
| #7665 | blocked | `1c0543d2062721272b16bb4f16c3a3edf7f762e8` | Superseded in master; closure unavailable | https://github.com/ashlrai/phantom/pull/8024; https://github.com/ashlrai/phantom/pull/8286; https://github.com/ashlrai/phantom/pull/7801 |
| #7652 | blocked | `68b9d8d558cb8c4f577e50021ae07d258ddc9324` | Superseded in master; closure unavailable | https://github.com/ashlrai/phantom/pull/8411; https://github.com/ashlrai/phantom/pull/8024 |
| #7593 | blocked | `798161f957bc95cb9d6422be24f2c67e14e04733` | Superseded in master; closure unavailable | https://github.com/ashlrai/phantom/pull/7934; https://github.com/ashlrai/phantom/pull/8013 |
| #7591 | blocked | `1ef9d09b9cd12dd0c442bd96a9131f029ab7f3ed` | 30 changed-suite tests pass; typechecks, scoped lint and verifier pass; baseline failures remain; publication prohibited | None established |
| #7588 | blocked | `401661ebfbd2bb34d9b9ca5066ff0930206e8089` | Superseded by later corrected CI guidance; closure unavailable | https://github.com/ashlrai/phantom/pull/8013 |
| #7583 | blocked | `0a9c6e8adcdcd0ab1980a14edbcd59f152af8b05` | Superseded in master; closure unavailable | https://github.com/ashlrai/phantom/pull/8013 |

## Supersession evidence

Every `git merge-tree --write-tree origin/master <head>` returned content
conflicts, not master's tree. Supersession was therefore evaluated by intent
and later merged diffs, not claimed as a tree-equality result.

- #7665: command-table coverage is in merged #8024 and #8286; the generalized
  syntax-check comment is in #7801. Master documents the Verse sync-I/O guard
  in the contribution guide and the native type checker in its command table.
- #7652: #8024 carries domain-type guidance in CONTRIBUTING and ARCHITECTURE;
  #8411 carries the exact CONTRACT and CODEMAP corrections and a preservation test.
- #7593: #7934 carries AGENTS, CLAUDE and CONSTRAINT-AUDIT changes; #8013 carries
  CONTRIBUTING's fast-versus-full hosted-check clarification.
- #7588 and #7583: #8013 carries fast PR/queue CI and scheduled full-suite/Mac
  rotation guidance. Current master includes subsequent workflow-call corrections;
  restoring the older prose would lose those corrections.
- #7591: master already handles job-id aliases, outcome-only jobs, parked
  dependencies, job yield and lane weights through newer implementations. The
  filler-yield, lane-yield and supply readers still missed reconciler outcomes.
  Three original regression cases failed on master, then passed with this repair.
  The repair reuses the existing jobs-ledger-dialect module, retains master's
  precheck guards and adds reconciler precedence plus bare-publish regressions.
  It avoids the obsolete new job-ledger module and its authority-snapshot edit.

Verified replacement PRs #8024, #8286, #7801, #8411, #7934 and #8013 are merged.
A notes-only PR or a file-overlap listing was not accepted as a replacement.

## Prepared local change

The unstaged source/test/contract diff is solely the remaining #7591 reader
repair. It is not a merge commit and has no new head SHA. To finish the original
branch later, merge current master into that existing branch, retain the newer
implementations listed above, and incorporate this delta before sanctioned
publication. Do not publish this audit as a replacement PR.

## Validation

Validation results are recorded in [BRIDGE_NOTES.md](../../BRIDGE_NOTES.md).
The independent unchanged-master baseline reproduces the documentation assertion
failure and fleet-outcomes dynamic-import timeout. Neither test was weakened.

## Draft one-line comments (not sent)

- #7665: Superseded by https://github.com/ashlrai/phantom/pull/8024; https://github.com/ashlrai/phantom/pull/8286; https://github.com/ashlrai/phantom/pull/7801.
- #7652: Superseded by https://github.com/ashlrai/phantom/pull/8411; https://github.com/ashlrai/phantom/pull/8024.
- #7593: Superseded by https://github.com/ashlrai/phantom/pull/7934; https://github.com/ashlrai/phantom/pull/8013.
- #7591: Reader conflict repair prepared and tested locally; publication is prohibited by the final task rule, and GitHub comment access is unavailable.
- #7588: Superseded by https://github.com/ashlrai/phantom/pull/8013.
- #7583: Superseded by https://github.com/ashlrai/phantom/pull/8013.

Final local status: full backend/web typecheck and required verifier pass.
Changed suites: 30 pass, 0 fail. Broader run: 120 pass, 1 baseline timeout.
Repository lint: 16 baseline errors and 265 warnings; changed-file lint passes.
Standalone real-I/O inventory fails on unchanged files; Verse guard passes.
No hosted checks were run on this uncommitted repair.
