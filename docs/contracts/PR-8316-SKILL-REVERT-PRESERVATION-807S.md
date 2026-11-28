# PR 8316 recovery skill revert preservation

This contract audits only the recovery-learning slice of PR #8316. Source head: `ec300acd1fef8fbcd6188fbd2f62fd175dc963d9` (matches the planner's recorded head). Compared master: `b43a84cb24173b5232bb5582b0164b3948eeae1f`, advanced from planner baseline `ee3ccc1182c`. The checkout is shallow, so ancestry and the original merge base were not established. Master commit `8246141d981c3bb06aee9b61a9e51f0f0897f672` (#8406) contains the two compared files; its introduction of those files is visible in this shallow checkout, but it is not claimed as the original author or full ancestry.

At those two heads, `src/core/fleet/skill-nudge.ts` and `test/skill-nudge-ledger.test.ts` are byte-for-byte identical. The source slice is `skill-nudge.ts` lines 176–208 (URL parsing and standing revert join), 248–325 (ledger fold, ownership and standing verdict), and 330–379 (sync forwarding and candidate writing); the original test slice is `skill-nudge-ledger.test.ts` lines 141–205 and 311–334. The source and test comparison does not import the rest of the PR.

| Original behavior | Current executable evidence in `test/skill-revert-original-807s.test.ts` |
| --- | --- |
| A standing merged verdict with an exclusively claimed reverted PR is discounted | Fold marks it reverted; sync withholds the candidate, while the same input without keys persists one. |
| Contested ownership does not resolve | A second job's PR claim keeps the recovery eligible. |
| An older verdict's PR does not taint the latest verdict | Reverting the older PR leaves the later merge eligible; reverting the later PR discounts it. |
| Batch and session-pool rows do not claim ownership | Both rows accompany the recovery without preventing its revert join. |
| Absent, null, empty and unmatched keys preserve the fold | Each matches the no-evidence result. |
| Nonmerged outcomes cannot become reverted merges via the standing set | Closed, empty and cancelled verdicts retain their outcomes without a revert flag. |

Integration is also present in the unchanged real daemon caller: `src/core/daemon/loop.ts:4844-4845` imports `syncSkillNudgesFromJobsLedger` and passes `{ signal, revertedPrKeys: revertedKeys() }`. The original head has the equivalent call at lines 4829–4830. This is inspection evidence, not a daemon integration test.

Verification: `HOME=$(mktemp -d) npm run test:ci -- test/skill-revert-original-807s.test.ts` passed 4 tests; the same command for `test/skill-nudge-ledger.test.ts` passed 21 tests. Tests use synthetic ledger rows and mocked candidate storage. See `BRIDGE_NOTES.md` for the complete command results and final compiler status.

The remainder of #8316, including version, release and backlog changes, is **unaudited**. This slice is not evidence to close #8316 or declare the whole PR complete.
