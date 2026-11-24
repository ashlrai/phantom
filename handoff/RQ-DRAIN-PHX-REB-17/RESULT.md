# RQ-DRAIN-PHX-REB-17 outcomes

All six PRs were verified open with matching supplied heads through connected GitHub metadata reads. None was closed, updated, merged or queued. No new head exists.

Blockers: the final user rule prohibits commits and pushes; gh cannot read its configuration (EPERM); connected GitHub tools have no PR write operations. Blocker comments could not be posted. The requested home-directory handoff destination is also denied (EPERM), so this report is saved in the worktree instead. No credentials were copied or modified.

Inspected master: `92a2101ef3dcf07dc615d07f10cfbf9332cf22c3`.

| PR | Action | New head SHA | Check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [#7333](https://github.com/ashlrai/phantom/pull/7333) | blocked | None; unchanged `b9c7ee325c6f77af945ae231eccbf55d1d0144a1` | Docs baseline passed; candidate not prepared | None; still open |
| [#7330](https://github.com/ashlrai/phantom/pull/7330) | blocked | None; unchanged `e0ce755538afb9a5b5cf9c19ebe00c2f5f166f32` | Unique learner integration; not validated | None; still open |
| [#7329](https://github.com/ashlrai/phantom/pull/7329) | blocked | None; unchanged `30e6f9ef37828087878d17b1fba885b28f47bd7a` | Baseline lane-console: 31 pass, 1 EPERM | None; still open |
| [#7328](https://github.com/ashlrai/phantom/pull/7328) | blocked | None; unchanged `345a38ce94fa51158fb7e0b31b15033ccac57cbb` | Baseline plan-check: 10 pass | None; still open |
| [#7323](https://github.com/ashlrai/phantom/pull/7323) | blocked | None; unchanged `4f8db794557cae5c010011b585599d3267a9d885` | Baseline fleet-work-feed: 37 pass | None; still open |
| [#7321](https://github.com/ashlrai/phantom/pull/7321) | blocked | None; unchanged `c3626c966a6cc7d99a54a9d6538d409324bdee7d` | Baseline lane-starved: 21 pass; full intent not validated | None; still open |

## Supersession evidence

- #7333: newer contributor/install guidance landed in https://github.com/ashlrai/phantom/pull/7421 and Merge Gate documentation evolved further in https://github.com/ashlrai/phantom/pull/8640. Candidate replacements only; every historical wording change has not been proved equivalent.
- #7330: `src/core/fleet/jobs-outcome-events.ts` is absent from master. Its ledger integration and nullable usage accounting remain unique in the inspected comparison. Do not close as superseded on this evidence. No conflict resolution or authority metadata edit was applied.
- #7329: https://github.com/ashlrai/phantom/pull/7351 removes exactly the duplicate lane-health loop deleted by this PR while adding empty-reason notes. Master has one enriched loop, with its provider boundary subsequently updated by https://github.com/ashlrai/phantom/pull/7363. Recommend closure naming #7351 when sanctioned writes are available.
- #7328: https://github.com/ashlrai/phantom/pull/7349 carries plan-check core, CLI and fixtures, adds duplicate checking, and retains its 10 passing tests. Recommend closure naming #7349 after confirming ancillary generated/help changes.
- #7323: master implements --open, implied claims and incomplete-hold preservation via a newer filter object and shared hold-index API. https://github.com/ashlrai/phantom/pull/8127 carries open-filter integration; earlier coverage work appears in #7561 and #7832. Current fleet-work-feed tests pass. Finish docs/CLI comparison before closure.
- #7321: much intent already landed: open supply (#7317), bus summaries (#7316), docs-check selection (#7314), queue observation (#7313 and later #7420), plus later contributor guidance. Full supersession across this mixed 26-file PR is unproved. Authority baselines and CODEOWNERS were not changed.

Initial merge-tree attempts returned unrelated histories because the checkout was shallow. After deepening origin/master by 2000 commits, all six returned conflicts (exit 1), not master's tree. Diagnostics are saved beside this report. No conflict tree was checked out and no merge commit was created. No generated files were edited.

## Validation

Results describe unchanged master, not resolved PR candidates. Hosted checks were not evaluated.

- Focused tests under nice with temporary HOME: 99 passed, 1 failed across 4 files. The failure is lane-console's loopback HTTP test, `connect EPERM 127.0.0.1`.
- Typecheck: exit 127, missing tsgo.
- Lint: exit 2, ESLint cannot load ../lib/cli.
- verify-changed: exit 0 on unchanged source; typecheck skipped for no changes, ESLint skipped for incomplete installation. Real-I/O and console synchronous-I/O guards passed.
- Documentation: exit 0, zero errors.
- Global Phantom install: exit 255, EPERM. Existing phm remained usable. Command registry and MCP listing succeeded; wire status exited 1 with unavailable/unwired client configurations. No wiring was attempted.

Suggested blocker comment, not posted:

Blocked in RQ-DRAIN-PHX-REB-17: this run prohibits commits/pushes and GitHub writes are unavailable; supersession evidence and baseline checks are in the local handoff.

Companion tools called: none. Connected GitHub tools used: get_pr_info and search_prs, reads only.
