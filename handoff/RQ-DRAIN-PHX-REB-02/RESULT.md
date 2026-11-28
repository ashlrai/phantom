# RQ-DRAIN-PHX-REB-02

All six PRs were open with matching supplied heads. No remote mutations were made. The final user rule prohibits commit, push, tag and publish. GitHub's connected tools support reads only; normal gh configuration is inaccessible and an isolated empty GH_CONFIG_DIR has no authentication. No credentials were read or copied. The requested runs-directory handoff location was denied by the host (EPERM); this is the worktree-local fallback.

| PR | Action | New head SHA | Check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| #8312 | blocked | unchanged: 817ca99ae8a132df2c648ca2779e59ed4e18e05d | Resolved uncommitted merge; focused tests 2 passed; scoped lint and verifier/backend typecheck passed (10 authority tests) | Not closed; #8411 is only partial preservation |
| #8272 | blocked | unchanged: 21d5dbc0b13dc0a10aad8aaf74b9d150da719581 | Resolved uncommitted merge; focused tests 98 passed; scoped lint, generated CLI reference and verifier/backend typecheck passed (10 authority tests) | Not closed; #8414 is only partial preservation |
| #8250 | blocked | unchanged: 2d7a60e9659f12557d65452146d35123944f280f | Closure-ready: resolved tree equals master; full replacement merged; 11 current regression tests passed | Not closed; https://github.com/ashlrai/phantom/pull/8290 |
| #8245 | blocked | unchanged: 47d47362f78b5d712b8ed1e39317ede8b16b46d0 | Closure-ready: complete resolved merge tree equals master; no unique changes | Not closed; https://github.com/ashlrai/phantom/pull/8241 and https://github.com/ashlrai/phantom/pull/8244 plus https://github.com/ashlrai/phantom/pull/8545 |
| #8234 | blocked | unchanged: 58a809ff7535a4df8598e730ab0663564b1db5b4 | Closure-ready: contribution guidance already present; resolved tree equals master; 3 current regression tests passed | Not closed; https://github.com/ashlrai/phantom/pull/8420 |
| #8223 | blocked | unchanged: a913ec795aa33f6da48807b78a25b68e81e1ad03 | Resolved uncommitted merge; focused web tests 26 passed; scoped lint and verifier/web typecheck passed (10 authority tests) | Not closed |

All prepared merges target fetched master e2e08ab176258428b661a3823a8ba48407d1d5ef, tree d2c094a9b8134e75325686c84b6b4e5dd126c1fe. Each candidate is an isolated clone in /tmp/rq-drain-phx-reb02/candidate-N. Original PR head remains HEAD, master remains MERGE_HEAD, and the index holds the resolved merge. No merge commit exists. The candidate-8245 index is exactly master's tree. Verify-N clones start at the same master with only the PR's unique delta applied, for bounded local verification.

The three adjacent resolved.patch files contain only unique changes relative to that master. Use the retained candidate clones to inspect the actual merge state. The patches are review artifacts, not authorization to erase master changes or force-push an existing branch.

Closure drafts:

- #8250: Superseded by https://github.com/ashlrai/phantom/pull/8290, which preserves all four source paths and assertions.
- #8245: Superseded by https://github.com/ashlrai/phantom/pull/8241 and https://github.com/ashlrai/phantom/pull/8244 plus https://github.com/ashlrai/phantom/pull/8545; the resolved merge tree is identical to current master.
- #8234: Superseded by https://github.com/ashlrai/phantom/pull/8420, which preserves the contribution workflow and expands guide navigation.

Blocker-comment draft for #8312, #8272 and #8223:

Conflict resolution and focused checks are prepared locally, but this job's final instruction forbids commit/push/publish; an authorized publisher must deliver the uncommitted merge and then enable squash auto-merge through the required queue.

No merge, close, auto-merge change, hosted-check success or new head SHA is claimed. No authority baseline, closure allowlist, CODEOWNERS or authority implementation was changed relative to master.

Final verification: 140 focused tests plus 30 authority tests passed, 0 failed. Three candidate verifiers and the root handoff verifier passed. Root verifier checked Markdown links, patch grammar and conflict markers. Scoped lint passed independently despite the incomplete repository ESLint package. Final master fetch unchanged; final six PR metadata reads still open with original heads. Implementation net delta: +679 LOC, 14 files, across the three independent candidates.
