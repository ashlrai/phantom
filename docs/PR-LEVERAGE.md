# PR leverage and daily delta

`phm fleet pr-leverage --json` reads `<ASHLR_RUNS_DIR>/fleet/open-prs.json`
(default `~/.ashlr-runs`) without network calls or writes. Supply `--input
portfolio.json` for a combined JSON array of open and merged PR exports from
**every enrolled ashlrai repo**. Coverage is explicitly snapshot-only: missing
repos, truncated exports and omitted outcomes cannot prove an empty portfolio.
Rows need canonical GitHub `url` and `number`; include `title,body,state,files,
updatedAt,mergeable,mergeStateStatus,isDraft,additions,deletions,mergedAt`.

Delta potential (40 points), user impact (20), dependent work (up to 30),
quality (-15 to 8), lane merge yield (up to 5), measured durability (up to 3),
staleness (up to -20) and conflicts (-15) explain every score. Impact and slop
signals inspect title/body only; tests and size are evidence hints, not proof
of correctness. `--jobs` defaults to the existing metrics/jobs.jsonl ledger;
missing history stays unknown. Dependencies use `Depends on <PR URL>`,
`Blocked by <PR URL>`, or `after=RQ-ID` declarations. Merge recommendations
respect dependencies; cycles and unresolved predecessors appear in
`dependencyBlocked`.

Same-job PRs and substantial file overlap form connected review clusters.
Reconcile each cluster into its `strongest` PR, preserve unique changes and
validation, then let an authorized agent decide whether to close alternatives.
Overlap alone never proves equivalence. Stale, behind, conflicting and low-score
work is flagged for agent rebase/review/close decisions. Nothing here closes PRs.
The existing merge-queue runner now shares leverage order across repos before
spending its cycle budget on submissions,
including auto-merge requests it already handles. Alternative cluster members
and dependent work await agent reconciliation. Holds, pinned paths, checks,
review, expected-head bindings and GitHub queue gates still decide eligibility.
Cross-repo dependents wait until their predecessor is observed merged.
Repos retain their independent GitHub queues; this does not reorder entries
already submitted or change the separate standing-proposal auto-merge service.

Run `phm fleet pr-leverage --input portfolio.json --record-delta --json` in the
daily metrics task to append yesterday's completed UTC day to
`metrics/pr-delta.jsonl`. `--day YYYY-MM-DD` backfills a complete day. Recording
is explicit; no schedule is installed. The ledger uses an exclusive writer lock
and skips identical rows. For corrections, readers take the latest row per
(day, repos) instead of summing revisions. PR merges join exports with ledger outcomes; line counts cover the
provided exports; successful, nonempty jobs are deduplicated by job ID across
the jobs ledger. Missing jobs evidence is null. `verifiedLines` counts additions
plus deletions only with complete, unique required checks bound to `headRefOid`
and completed before merge. Include `requiredChecks` and `statusCheckRollup`
with each context's `headSha,completedAt,name,conclusion`; ordinary gh exports
lack this proof and count as `unmeasuredPrs`. A failed or unknown check earns
no verified lines. This is check evidence, not a post-merge stability claim.
