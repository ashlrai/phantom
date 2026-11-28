# RQ-DRAIN-PHX-REB-27

Evidence base: master `2c2008f2611078ca36c73abd92517b79db55f45f`.
All six supplied heads were verified open and unchanged before investigation
and again after local verification.
No PR was merged, closed, committed, pushed, tagged or published by this job.

The final instruction to leave changes uncommitted controls publication.
Separately, connected GitHub comment and close requests both returned HTTP 403
with `Resource not accessible by integration`; the existing GitHub CLI could
not read its configuration. No credentials were copied, changed or printed.
The requested handoff directory was denied by the environment, so this file
is the local fallback. Linked-worktree creation was also denied; standalone
local clones hold the pending, uncommitted merges, with review patches here.

## Per-PR outcome

Actions below describe completed remote outcomes, not intended follow-up.
Every action is blocked because no remote mutation succeeded. There is no new
head SHA; the listed SHA is the unchanged verified head. Check status refers
to existing-head CI, followed by local candidate or preservation checks.

| PR | Action | New head SHA | Check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [6733](https://github.com/ashlrai/phantom/pull/6733) | blocked | Unchanged: `4ae96d0a8fc9afa886dbe559b133e86453bfa9b5` | Existing Merge Gate failed; all 11 preserved tests passed; ready for supersession closure | Not closed; verified target [8170](https://github.com/ashlrai/phantom/pull/8170) |
| [6633](https://github.com/ashlrai/phantom/pull/6633) | blocked | Unchanged: `6d3fe0e3172a84a9cce58d2df49f9f2b86fcf316` | Existing Merge Gate failed; both preserved qualification tests passed; ready for supersession closure | Not closed; verified target [7013](https://github.com/ashlrai/phantom/pull/7013) |
| [6577](https://github.com/ashlrai/phantom/pull/6577) | blocked | Unchanged: `bc14a9c6491fb068d1eaee2fb50094180b760c4e` | Existing Merge Gate failed; 39 current empties tests passed; ready for supersession closure | Not closed; verified target [6986](https://github.com/ashlrai/phantom/pull/6986) |
| [6560](https://github.com/ashlrai/phantom/pull/6560) | blocked | Unchanged: `e333a21b0af407a335a5f2081cbf1af6aca353b7` | Existing Merge Gate passed but branch conflicts; candidate 61 affected tests passed, authority 9 passed/1 failed; both typechecks and changed lint passed | None established |
| [6547](https://github.com/ashlrai/phantom/pull/6547) | blocked | Unchanged: `b9b3c376f56fbc33e8a3390de5b191751137f845` | Existing Merge Gate failed; candidate 265 distinct focused tests passed, both typechecks and changed lint passed; broad gate has unchanged-master failures | None established |
| [6538](https://github.com/ashlrai/phantom/pull/6538) | blocked | Unchanged: `882b3a89f1c3cbd27f9a5c69238aa620f6f1b3ec` | Existing Merge Gate failed; 15 asks tests, both typechecks and docs passed; broad gate has unchanged-master failures | Not fully superseded; implementation in [8184](https://github.com/ashlrai/phantom/pull/8184) |

Existing-head `Secret-shape scan` checks passed for all six. Literal
`secret-shape` and `clean-tree` contexts were not returned by the inspected
check-runs endpoint and are not claimed green. Required check names and rules
were not changed. Full check names, outcomes and links are in
[the evidence file](pr-evidence.json).

## Supersession proof

After deepening the shallow history, `git merge-tree --write-tree` found the
expected conflicts. For 6733, 6633 and 6577, retaining reviewed master content
at the conflicting paths produced exactly master's tree
`48f4f13519178f9eefb2def36dd00f3ea4a8589e`, with no remaining diff.
Separate temporary indexes were used; no source branch or commit was changed.

- 6733: three files are byte-identical; the fourth constructs the same privacy
  fixture marker dynamically while preserving its assertions. Merged 8170
  carries all four tests through the intervening recovery chain.
- 6633: the existing qualification test retains its v2 equality and privacy
  assertions and additionally checks the newer CLI `why` block. Merged 7013
  carried the original test.
- 6577: merged 6986 carries all of the v2 fleet report, CLI, MCP, docs and test
  intent. Later master changes add reporting without removing these contracts.

The one-line closure comments below are prepared but were not posted:

```text
6733: Superseded by https://github.com/ashlrai/phantom/pull/8170. All four tests are preserved on master, including the equivalent privacy-marker fixture repair.
6633: Superseded by https://github.com/ashlrai/phantom/pull/7013. The qualification test is preserved on master with the additive CLI why assertion.
6577: Superseded by https://github.com/ashlrai/phantom/pull/6986. The fleet empties v2 CLI, MCP, documentation and tests are preserved on master.
```

## Uncommitted candidates

- [6560 patch](6560-candidate.patch),
  [verification](6560-verification.md): wiki brief behavior and
  cloud context integration retained. Three conflicts resolved; CLI reference
  regenerated. The authority snapshot, CODEOWNERS and authority source remain
  exactly master's bytes. The closure guard rejects six newly reachable wiki
  modules. This job may not update that baseline to make it pass.
- [6547 patch](6547-candidate.patch),
  [verification](6547-verification.md): phone Library preserved;
  gateway conflict keeps master's guards and original exact read routes.
  Historical qualification tests now enforce the intended unavailable-file
  contract. The shell tests settle real dynamic imports, retaining assertions
  and timeout budgets. A new regression prevents simultaneous unavailable and
  empty claims. Final focused results: 137 backend and 128 web tests passed.
  Both typechecks, changed-file lint and docs passed. The broad gate still
  reports inherited master issues and a relative executable-shim failure.
  All 51 cited existing paths match master. The original optional A5 followup
  patch remains intact and applies cleanly; asks data was not changed.
- [6538 patch](6538-candidate.patch),
  [verification](6538-verification.md): one missing contract
  paragraph restored, +7/-0. Five original source/test/report files already
  match master exactly and the asks registry entry exists. The omission is
  why this PR is not closed as fully superseded by 8184.

Patches contain each candidate's unique delta against the pinned master
snapshot, excluding verification notes. They are review artifacts, not pushed
branch heads. Each candidate retains its original HEAD and a pending master
merge, without a merge commit. No rebase or force-push was used.
All three exported patches apply to the pinned master in temporary indexes,
and every changed file matches the verified candidate's bytes. See
[patch receipts](patch-verification.json).

| Candidate | Unique paths versus master | Added | Removed | Net LOC |
| --- | ---: | ---: | ---: | ---: |
| 6560 | 10 | 160 | 3 | +157 |
| 6547 | 26 | 501 | 115 | +386 |
| 6538 | 1 | 7 | 0 | +7 |

No candidate is claimed fully green for publication. The shared broad gate
found inherited master lint, malformed-fixture, quarantine and real-I/O issues;
these were recorded without modifying unrelated tests or guards. The wiki
candidate additionally has its own authority closure blocker.

The wiki blocker comment, also not posted:

```text
6560: Blocked: the master merge adds six wiki modules to the Tier-1 import closure; this job prohibits updating the protected authority baseline.
6547: Blocked: local merge candidate passes focused tests and typechecks, but publication is prohibited for this job and the existing master baseline gate is not green.
6538: Blocked: local merge candidate preserves the missing contract paragraph, but publication is prohibited for this job and the existing master baseline gate is not green.
```
