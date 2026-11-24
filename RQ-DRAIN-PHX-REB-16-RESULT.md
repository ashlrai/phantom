# RQ-DRAIN-PHX-REB-16 outcomes

All six supplied heads matched and all six PRs were open during this run. Base master: `8a2dd8c65b4dc803edfeb632cdd800e32c9129b9`.

The final user instruction prohibits commits, pushes, tags and publication and requires uncommitted handoff. It supersedes the earlier instruction to publish merge commits. No original PR was merged, closed, commented on or modified. The GitHub CLI cannot read its configuration (EPERM); the available GitHub connector is read-only. No credentials were copied or read to work around this restriction.

| PR | Action | New head SHA | Hosted check status at unchanged head | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [#7365](https://github.com/ashlrai/phantom/pull/7365) | blocked | none; unchanged `45be74bc00f10ec6aa06bbcb4446790d4e5265ea` | Merge Gate: failure; secret-shape: no returned check run; clean-tree: no returned check run | none; not closed |
| [#7364](https://github.com/ashlrai/phantom/pull/7364) | blocked | none; unchanged `e7ea473bc75a2a74f496776d2ace5ad98fe2b50a` | Merge Gate: failure; secret-shape: no returned check run; clean-tree: no returned check run | none; not closed |
| [#7360](https://github.com/ashlrai/phantom/pull/7360) | blocked | none; unchanged `19f9f816728028ada02cd2a761bec52ccd131986` | Merge Gate: no returned check run; secret-shape: no returned check run; clean-tree: no returned check run | none; not closed |
| [#7356](https://github.com/ashlrai/phantom/pull/7356) | blocked | none; unchanged `d83ff4068562d6b13c3ede9937b6a2cb7c6fc233` | Merge Gate: no returned check run; secret-shape: no returned check run; clean-tree: no returned check run | none; not closed |
| [#7339](https://github.com/ashlrai/phantom/pull/7339) | blocked | none; unchanged `f1c12eb2cff470bdebf918d64365b03de0ca13af` | Merge Gate: failure; secret-shape: no returned check run; clean-tree: no returned check run | none; not closed |
| [#7334](https://github.com/ashlrai/phantom/pull/7334) | blocked | none; unchanged `bf47eee8ca212746338fd06f4b4eb8a262f661f3` | Merge Gate: no returned check run; secret-shape: no returned check run; clean-tree: no returned check run | none; not closed |

No returned check run is not proof that a required check is absent or passed. Only returned named check runs are reported above.

Supersession assessment:

- #7365: no complete replacement established. Outbox help is already represented by #7382; unique changelog and completion subcommand additions remain. Generated documentation must be regenerated in a future authorized merge.
- #7364: contributor guidance is substantially represented on master, including merged #8182 and later edits. Candidate closure after complete semantic confirmation: https://github.com/ashlrai/phantom/pull/8182. No closure performed.
- #7360: merged #7377 already carries shed-aware lane calculations, but this source also adds laneLaunchHeadroom, strict effective_target validation and parked-row coverage not verbatim on master. No complete replacement established. Authority snapshot conflicts must not be resolved by weakening guards or editing baselines to pass.
- #7356: typed job-tail records, error wording and phone-layout changes remain absent from master. No complete replacement established.
- #7339: master has outbox completion and the help row added by newer merged #7382. Candidate semantic replacement: https://github.com/ashlrai/phantom/pull/7382. No closure performed.
- #7334: newer merged #7381 adds the release-PR freeze, with subsequent master refinements to discovery and required-check handling. Candidate semantic replacement: https://github.com/ashlrai/phantom/pull/7381. Current cadence tests pass. No closure performed.

All six `git merge-tree --write-tree origin/master <head>` calls returned 1 with conflicts. None returned master's tree. This read-only object analysis did not create commits or modify source files.

Number searches found #8264 and #8239 mentioning these six PRs only in candidate inventories. Their changed-file sets do not implement the six changes, so they were not accepted as replacements. Open #8131 and #8312 also only mention the candidates while preserving unrelated work.

No source/test changes were selected because publication is prohibited and remote mutation is unavailable. Baseline check results and exact command patterns are in BRIDGE_NOTES.md. All outcome rows intentionally say blocked, rather than claiming a merge or closure that did not happen.
