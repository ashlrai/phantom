# RQ-DRAIN-PHX-REB-15 outcomes

Inspected on 2026-11-24. All six PRs were open with matching expected heads. No remote mutation occurred. The requested handoff destination could not be created: Operation not permitted. This is the local fallback copy.

The final task instruction prohibits commits, pushes, tags and publication. GitHub CLI configuration access fails with EPERM; an isolated empty configuration has no authenticated session. Available connected GitHub tools are read-only. Credentials were not inspected, copied or changed.

Tested checkout: c2a6acd47ffa05005caa11aba59b5ccb7f7f500c. The shared origin/master reference advanced during inspection; checks below apply to the tested checkout.

| PR | Action | New head SHA | Hosted check status at existing head | Replacement URL (closure pending) |
| --- | --- | --- | --- | --- |
| [#7438](https://github.com/ashlrai/phantom/pull/7438) | blocked | 5709bc327dd763a273c67f1ae2af126d70504dce (unchanged) | Merge Gate absent in returned check runs | https://github.com/ashlrai/phantom/pull/8158 |
| [#7424](https://github.com/ashlrai/phantom/pull/7424) | blocked | 553d8ce11b3a9467841919cd3945744c7bb8074b (unchanged) | Merge Gate absent in returned check runs | https://github.com/ashlrai/phantom/pull/8229 |
| [#7399](https://github.com/ashlrai/phantom/pull/7399) | blocked | c83cb1275bfd259bcac774a44d3efe048b7dfb81 (unchanged) | Merge Gate absent in returned check runs | None; partial overlap with #7385 |
| [#7393](https://github.com/ashlrai/phantom/pull/7393) | blocked | 89c7a0c41343885a7607128eeecc5917f67a048a (unchanged) | Merge Gate success | https://github.com/ashlrai/phantom/pull/7547 |
| [#7383](https://github.com/ashlrai/phantom/pull/7383) | blocked | 46e420b46db6f3527c7c476ef2063fa53d2b44a7 (unchanged) | Merge Gate failure; fast gate failure | https://github.com/ashlrai/phantom/pull/8145 |
| [#7373](https://github.com/ashlrai/phantom/pull/7373) | blocked | e032141ace7510ed755437369766aa03fdc0d892 (unchanged) | Merge Gate failure; fast gate failure | https://github.com/ashlrai/phantom/pull/8180 |

Action remains blocked rather than closed-superseded because closure did not occur. Existing check results do not prove the conflicted PR can merge.

## Evidence and draft comments

1. #7438 is superseded by #8158: byte-identical load-history.ts plus CLI, self-tick, pulse and digest integrations and broader tests. Draft closure: Superseded by https://github.com/ashlrai/phantom/pull/8158, which ships host-load history and its integrations.
2. #7424 is superseded by #8155 plus #8229: digest core, original mason digest alias, completions and order-notices integration. Draft closure: Superseded by https://github.com/ashlrai/phantom/pull/8229, which completes the hourly digest already shipped in #8155.
3. #7399 is not fully superseded. #7385 ships declined-session, capability and GitHub-auth fences, but explicitly preserves leader-selected owner scope. #7399 additionally rejects foreign and ownerless jobs. No owner-policy change was discarded. Draft blocker: Blocked: the final job instruction prohibits commit/push/publish, and this PR retains an owner-scope restriction absent from #7385.
4. #7393 is superseded by #7547: identity-aware claims and exact-label fallback on unreadable registry, with tests. Draft closure: Superseded by https://github.com/ashlrai/phantom/pull/7547, which ships identity-aware seat handoffs and unreadable-registry coverage.
5. #7383 is superseded by #7421 plus #8145: contribution entry, npm ci setup, squash-title guidance and fast-gate/scheduled-CI instructions, subsequently refined on master. Draft closure: Superseded by https://github.com/ashlrai/phantom/pull/8145, which completes the contributor workflow already introduced in #7421.
6. #7373 is superseded by #8180: Models row and broader cached-error/unknown-registry tests. Draft closure: Superseded by https://github.com/ashlrai/phantom/pull/8180, which ships the Models row with broader error-state tests.

Replacement PRs #8158, #8155, #8229, #7547, #7421, #8145 and #8180 were independently confirmed merged through GitHub API. Merge-tree returned conflicts for every target after shallow history was deepened. Supersession rests on inspected replacement commits and behavior, not a clean tree-equality claim.

## Validation

Backend: 138 passed, 1 failed across 10 suites (139 tests). Existing failure: test/contributing-verify-changed.test.ts:37 expects an obsolete CI comment. Web: 7 passed across 2 suites. check:docs: passed, zero errors. verify-changed: passed with zero tracked changes, typecheck skipped and ESLint unavailable. Standard typecheck cannot run because tsgo is missing. Standard lint cannot run because ESLint cannot load its cli module. Fallback TypeScript status and exact commands are recorded in BRIDGE_NOTES.md.

No source, generated file, security gate, authority baseline or required-check configuration changed. Tracked source net LOC: 0. All report artifacts remain uncommitted.

toolsUsed: GitHub.fetch_pr, GitHub.fetch, GitHub.search_prs. Companion MCP tools called: none.
