# RQ-DRAIN-PHX-REB-09 outcomes

Base audited: `4b6ec61d064de3c362496f5bce081ac56654693f`. All six PRs verified open at their expected heads.

The final instruction prohibits commits, pushes, tags and publishing. Changes remain uncommitted. No PR was merged, closed or commented on. Local gh configuration access failed with EPERM; connected GitHub tools support reads only. The requested handoff directory also rejected creation with EPERM, so this is the local fallback report.

| PR | Action | New head SHA | Check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| #7884 | blocked | None; unchanged `1dc1cdd6cd24cdc54d1f9da2bcaacdefc6a25803` | Supersession verified; no branch checks | Not closed |
| #7876 | blocked | None; unchanged `e5ebfe2c81fe676b4573fd7b22c0efbc32520297` | Supersession verified; no branch checks | Not closed |
| #7869 | blocked | None; unchanged `d572043aa1c539129f8bae87347af440845c7375` | Local docs/typecheck pass; lint failed on existing errors; final focused tests 19/19 | Not closed |
| #7864 | blocked | None; unchanged `4aabf71511d815a2f47dd91fad2ad06337f7cd3f` | Local docs/typecheck pass; lint failed on existing errors; final focused tests 19/19 | Not closed |
| #7860 | blocked | None; unchanged `85c3ee37754592ccd1011dfc803fe13520255cef` | Supersession verified; no branch checks | Not closed |
| #7843 | blocked | None; unchanged `310f003557f408053bd2e63f947460dbe21ac1c3` | Supersession verified; no branch checks | Not closed |

## Evidence and remaining actions

- #7884: CI prose superseded by [#8013](https://github.com/ashlrai/phantom/pull/8013), refined by [#8263](https://github.com/ashlrai/phantom/pull/8263). Closure pending GitHub write capability.
- #7876: CI prose superseded by [#7934](https://github.com/ashlrai/phantom/pull/7934); Sessions link by [#7908](https://github.com/ashlrai/phantom/pull/7908). Closure pending GitHub write capability.
- #7869: tidy built-dist marker already in [#8013](https://github.com/ashlrai/phantom/pull/8013). Missing contributor guidance restored locally. Publication prohibited by final instruction.
- #7864: detector/pool display recovered by [#8146](https://github.com/ashlrai/phantom/pull/8146); router recovered by [#8274](https://github.com/ashlrai/phantom/pull/8274). Missing documentation restored locally, preserving stricter timestamp validation and unknown plan readings. Unused helper exports were not added. Publication prohibited by final instruction.
- #7860: scheduled CI prose superseded by [#8013](https://github.com/ashlrai/phantom/pull/8013). Closure pending GitHub write capability.
- #7843: audit workflow prose superseded by [#7901](https://github.com/ashlrai/phantom/pull/7901) and [#8037](https://github.com/ashlrai/phantom/pull/8037). Closure pending GitHub write capability.

All six merge-tree probes report conflicts after deepening history. Supersession findings come from inspected intent and replacement commits, not equal merge trees. No generated files, authority files, security controls, workflows or tests changed. Hosted checks and queue admission were not run.

Final focused tests: 19 passed, 0 failed across four suites. Earlier focused run: 16 passed, 1 failed because contributing-verify-changed.test.ts expects an obsolete comment in unchanged ci.yml. Initial typecheck/lint failed on incomplete dependencies; npm ci repaired dependencies. Final typecheck and docs checks passed. Full lint failed on existing errors.

toolsUsed: [] (no companion MCP tools; connected GitHub metadata tools used).

Full lint completed with 16 errors and 265 warnings in unchanged files, including undefined console in CI scripts and unused imports in GitHub tests. No linted source file was modified by this task. Repository-wide lint was not made green by this documentation-only change.
