# RQ-DRAIN-PHX-REB-20 outcomes

No remote mutations were performed. All six PRs were verified OPEN at the supplied heads. No commit, push, tag, publication, merge-queue entry, auto-merge change, closure, or PR comment was made. The final no-commit/no-push instruction overrides the earlier delivery steps.

The requested handoff directory could not be created: the filesystem returned Operation not permitted. This is the local fallback copy.

| PR | Action | New head SHA | Check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [7212](https://github.com/ashlrai/phantom/pull/7212) | blocked | unchanged: 3403a027c1c6f11ebfd9fe0b2d2d6aa8f6c638da | Superseded; shared UI validation 72 passed; closure unavailable | None: not closed |
| [7197](https://github.com/ashlrai/phantom/pull/7197) | blocked | unchanged: e95bd97653b8bd8136088b784f0f5d850f58f580 | Local resolution: typecheck and targeted lint pass; API 2 passed, 57 failed on loopback EPERM | None |
| [7193](https://github.com/ashlrai/phantom/pull/7193) | blocked | unchanged: 793172ea490766f1dcb27bcf60ac6f52604f1156 | Superseded; shared UI validation 72 passed; closure unavailable | None: not closed |
| [7178](https://github.com/ashlrai/phantom/pull/7178) | blocked | unchanged: 6b472075a84bfdf73aa4fb04ba3cded1d0e5a561 | Superseded; shared UI validation 72 passed; closure unavailable | None: not closed |
| [7171](https://github.com/ashlrai/phantom/pull/7171) | blocked | unchanged: 77cc17cb7451b08874916768bccbaf4b3f607bf7 | Superseded; shared UI validation 72 passed; closure unavailable | None: not closed |
| [7169](https://github.com/ashlrai/phantom/pull/7169) | blocked | unchanged: 76d8df1c42a1b2ea531ac1367bb1b3617b4d1459 | Local resolution: 15 passed, typecheck and targeted lint pass; authority suite 9 passed, 1 failed (inherited CODEOWNERS drift) | None |

Hosted required-check status was not verified. No local result is a hosted Merge Gate, secret-shape, or clean-tree result.

## Verified supersession and ready closure text

- #7212: `Superseded by https://github.com/ashlrai/phantom/pull/7661.` The added catch-up components, models, CSS and regression tests are identical; master already has the documentation and integration. Resolving the documentation conflict in master's favor leaves master's tree.
- #7193: `Superseded by https://github.com/ashlrai/phantom/pull/7654.` The roster implementation, models and regression tests were recovered there; master contains newer session-thread following and beside-layout behavior.
- #7178: `Superseded by https://github.com/ashlrai/phantom/pull/7201.` Readings implementation, model, CSS and regression tests are identical; newer Home integration and documentation are retained.
- #7171: `Superseded by https://github.com/ashlrai/phantom/pull/7670.` Delivery implementation, model, CSS, tests and shared throughput queries are identical; newer throughput presentation remains.

These are verified replacement recommendations, not recorded closures. The GitHub app exposed read tools only. GitHub CLI initialization failed while reading its configuration. No credentials were copied and no authentication configuration was changed.

## Unique changes prepared locally

- #7197: [review-patches/7197.patch](review-patches/7197.patch), 4 files, +81/-3, net +78. Master's Router pane supersedes the old UI through #7651, but does not contain the single-reading batch budget-routes endpoint. Kept that endpoint, its types, contract and regression coverage. No authority guard or baseline was changed for this resolution.
- #7169: [review-patches/7169.patch](review-patches/7169.patch), 12 files, +682/-1, net +681. Preserved outcome-based cohorts, bounded advisory weights, deduplicated append journal, CLI, tests and docs. Kept master's router outcomes dispatcher and merged tune alongside it. Regenerated CLI references and llms documentation with the repository generator. Retained the PR's pre-existing CODEOWNERS addition; it fails current generated-block drift. No authority regeneration, baseline change, closure allowlist change, or security-test weakening was used to repair that failure.

The patches are independent diffs against master 587bb0ec9e9211c1d32d8ae1b693e313cc663c15. Both are also applied, uncommitted, in the final worktree on that detached master snapshot. They must remain separate PR updates. No merge is pending.

Ready blocker comments, not posted:

- #7197: `Blocked: batch routing endpoint resolved locally, but loopback EPERM prevents API verification and this job prohibits commits/pushes.`
- #7169: `Blocked: local tests pass, but inherited CODEOWNERS drift remains; this job prohibits authority metadata fixes and commits/pushes.`

Companion toolsUsed: []. GitHub app reads were used for PR metadata.
