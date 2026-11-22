# Outcome learning

Status: source-complete. The dispatch log is the memory. There is no operator
setting for the weights, the exploration rate, or the failure threshold.

## What it records

`learnOutcomes` reads a dispatch event log. A finished job is an `ASSIGN` or
`LAUNCH` (with resource, model, job type, and repo) followed by an `OUTCOME`
(`merged`, `closed`, `dirty`, or `fixup`, plus usage, optional minutes, and
`breakage=0|1`). The same facts may arrive as JSON lines. Legacy
`LAUNCH job repo lane tier` rows are ignored. For each
(resource, model, job type, repo) the view reports merge rate, time to merge,
usage, and breakage rate.

`learnFleetOutcomes` folds the second evidence source the fleet actually
writes: the jobs ledger (`metrics/jobs.jsonl`, read as a bounded tail).
Dispatchd `launch` rows are the assigns — `lane` is the resource and `tier`
keys job type, the only work-shape field the ledger records — `finish` rows
supply the `tokens_total` usage reading joined by job id, and the
metrics-outcomes reconciler's `MERGED`/`CLOSED` rows are the verdicts.
A `finish` row that records `empty: true` — dispatchd's diff check found
nothing publishable, so no PR can ever carry a verdict — resolves its open
assign as a closed non-merge on the spot and charges the row's own
`tokens_total`; `empty` absent, `false`, or `null` (unmeasured) leaves the
attempt open for the reconciler, and `pool_error`/`failure_class` fields on
a non-empty finish never close it. Minutes-to-merge is the reconciler stamp
minus the launch stamp. An outcome
with no usage reading is charged the measured mean of its cell (the fleet
mean when the cell has none); when nothing anywhere reported usage, missing
readings stay uncharged rather than reading as zero spend. `phm fleet
outcomes` reads both sources by default; `--ledger <file>` overrides the
jobs-ledger path and `--events <file>` the dispatch log.

Usage readings carry their unit. `usage`/`meanUsage` sum every recorded
reading whatever its unit, which is what the cheapness posterior reads. Each
cell also reports `usageAllowance` — the summed dispatch-log `usage=`
readings in the allowance unit (roughly 0.04-1.2 per job) — and
`usageAllowanceKnown`, the count of attempts that contributed one.
Jobs-ledger `tokens_total` readings (thousands per job) and the imputed
reconcile/censor charges are never allowance readings, so a consumer
calibrated to the dispatch unit, like the selector's `estUsage`, cannot be
distorted by token counts.

Batch sessions count per member, not per session. A `batch_claim` row is the
member's dispatch record, held until the session's own `launch` row — which
carries the `RQ-BATCH-*` infrastructure id, never an attempt — opens one
attempt per recorded member at the session's stamp. A bundle released before
launch (spawn failure, route-lock busy) therefore counts nothing, matching a
solo launch that never wrote its `launch` row. A member's `task_outcome`
row closes its attempt as unmerged only for the requeue words
(`failed`/`deferred`/`unreported`); `done`/`skipped` members still publish
on their own and resolve on the reconciler verdict, and members get no
per-member `finish` row so their usage is charged like any unread outcome. A
`launch_failed`/`launch_terminal` row naming the session id closes every
member attempt it opened.

Node-pool producer rows are a different jobs-ledger dialect and never
count here: `fleet.session-pool.v1` and `phm-node-runner.v1` rows carry
the per-attempt id in `job` and the logical `ready:*` queue id in
`jobId`, and none carries the repo/lane/model/tier assign fields a cell
needs — so they skip like other operational rows instead of counting
malformed (a session-pool `launch` reuses the dispatchd event name) or
keying usage on a phantom claim id. The router outcome fold consumes
the same rows keyed on `jobId`; see `readRouterOutcomes`.

Revert evidence discounts merges exactly the way the reward feed and slot
yield already read it (`hasRevertEvidence`: `reverted:true`, a parseable
`reverted_at`/`revertedAt` stamp, or a `revert`/`reverted` event or state
name; explicit `reverted:false` is not evidence). The fold reads the newest
revert-evidence line per job across the retained window before resolving
verdicts: a `MERGED` verdict at or before that line resolves as `reverted` —
a failed attempt that still spent its recorded usage, counted in `attempts`
and the cell's `reverted` total, never in `merges` or `goodMerges`. Revert
evidence older than the verdict belongs to an earlier merge era and leaves
the merge held, so a later merge is a fresh held merge. An attempt still
open at the end of the window whose job carries revert evidence recorded
after its own launch resolves `reverted` too: the revert proves a merge
existed and did not hold, so the attempt is a recorded failure rather than
missing data for the censor horizon. The dispatch-log dialect has no revert
signal and is unchanged.

A second revert source joins when the caller supplies the standing keys
resolved from `$ASHLR_HOME/improve/revert-outcomes.jsonl` — the detections
`phm fleet reverts --record` appends for merges only git history proves,
which the jobs ledger and dispatch log never record. `learnFleetOutcomes`
takes them as an optional fourth argument (`revertedPrKeys`,
`owner/repo#n`); both CLI callers (`phm fleet outcomes`, `phm select`)
resolve them through `readStandingRevertKeys`, which contributes an empty
set unless the ledger reads whole — corrupt evidence never discounts a
merge. A `MERGED` verdict whose own PR URL is claimed by exactly that job
(the same unambiguous-claim rule the router outcome fold applies) and
whose key stands in the set resolves `reverted` instead of a held merge.
Because the check reads the verdict row's own URL, a recut relaunch's
merge of a different PR stays held exactly like the in-ledger era rule,
and a contested or foreign claim never discounts. Absent, empty or
unmatched keys change nothing.

## How it routes

`routeLearnedJob` draws a Thompson sample from a Beta success posterior and a
Gamma cheapness posterior. Success is a merge that did not break main.
Cheapness is the inverse of usage, so the draw favors the cheapest resource
that ships. A cold resource still wins some draws; that is the exploration.

When a resource's observed time to merge is longer than the time left before
its allowance resets, it cannot take the job. Among resources that can finish,
one whose allowance resets sooner gets a higher score, which is the
usage-before-reset balance. A critical job never returns `wait`: if something
can take it now, it is sent there; if nothing can, the action is `nowhere`.

The plain-language reason names the constraint that decided the assignment,
for example `Sent to Devin because CMP Codex resets in 40 min with 5% left.`

`learnedSeatPenalty` turns the same posterior means into seat-router penalties.
Omitting the penalty leaves `routeSeat` unchanged.

## Improvement jobs

A failure pattern becomes an improvement job when it has happened at least
three times and, for a low merge rate, good merges are the minority. The jobs
are data. This module does not enqueue them, spend, or merge.

## Surfaces

`phm fleet outcomes` and `phm fleet outcomes route` print the view. `--json`
is the same object the desktop imports from
`desktop/outcome-learning-view.ts`.
