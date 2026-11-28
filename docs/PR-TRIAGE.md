# PR triage

```sh
phm prs triage --repo ashlrai/phantom --limit 100 --json
```

The read-only `prs.triage.v1` report contains `repo`, `generatedAt`, `complete` (false when the limit is reached), verdict `counts`, and `prs`. Each PR has `number`, `headBranch`, GitHub `mergeable`, `checks` (success, failure, pending, or unknown), `ageSeconds`, `verdict`, and `evidence`. GitHub metadata is a snapshot; fetched heads must match it. No GitHub writes are made.

`superseded` means the entire nonempty net binary patch reverse-applies to the fetched base index. `rebase-clean` and `rebase-manual` describe a trial merge-tree for a GitHub-conflicting PR. Otherwise failing checks and green checks give `failing-checks` and `green`. Missing evidence, pending checks, moved heads, and inspection errors yield `unknown`. A clean trial merge is advisory and does not prove a rebase or CI will succeed. Reverse application is conservative: context changes can hide already-landed hunks.

For known verdicts, `evidence` contains the full fetched `headSha`, the tested `baseTipSha`, and their common `mergeBaseSha`. `proof` is `"reverse-patch"` only for `superseded`; it is otherwise null. When the observed head moves, inspection fails, or the verdict is unknown, `evidence` is null. These IDs describe the inspection, not current branch tips. Revalidate both tips before using a report to make any repository-management decision.

A report freezes one fetched base tip per branch and fetches PR heads in groups of up to 25. If Git identifies a missing head in a batch, the remaining heads are retried individually against the same base. A timeout or unclassified fetch failure leaves the affected batch unknown. The report does not update, close, or merge any PR.

## Offline three-way triage for a large queue

When a trusted local checkout already has the exact PR commit objects, the
batch utility avoids network calls and disposable checkouts. Save an explicit
JSON snapshot of `[{"number":123,"headSha":"<40 lowercase hex>"}]` and pin the
observed default-branch SHA:

```sh
python3 scripts/pr-tree-triage.py --repo /path/to/phantom --base "$BASE_SHA" --snapshot pr-heads.json
```

Each result binds the PR head SHA and the shared base SHA. The script writes
only temporary Git objects, never updates refs, and never contacts GitHub.
`clean-file-change` means the trial tree differs from base and Git reported
no conflicts; it says nothing about tests, approval, or policy.
`no-file-change` means the successful trial tree equals base, not that the
PR is authorized to close: confirm the current exact revisions and rule out
intentional reverts, history-only work and dependencies. A conflict remains a
conflict even if the Git subprocess returned zero. Missing local objects,
timed-out batches, and unrecognized output remain `unknown`.
