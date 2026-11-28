# Outcome learning

Status: source-complete. The dispatch log is the memory. There is no operator
setting for the weights, the exploration rate, or the failure threshold.

## Skill outcome content identity

An optional `skillContentHash` in each `TrajectorySkillOutcomeRow` carries
the recorded content digest when every joined observation for the revision
identifies the same content. Conflicting digests withhold the revision's
tallies. A missing digest leaves the historical tallies available without
the field. Improvement discovery requires this digest to match the current
card and requires agreement across all records of that current revision.

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

A third evidence source joins the same way when the caller supplies the
per-PR merge-queue map `foldMergeEvents` produces from
`metrics/merge-events.jsonl` — `learnFleetOutcomes`'s optional fifth
argument (`mergeQueue`, `owner/repo#n` → evidence). Each verdict's own
unambiguously claimed PR contributes its recorded friction to the
attempt: conflicts, recuts or a conflict `blocked` reason set the attempt's
`mergeDirty` flag, and required-check failures or failed retries set
`mergeFixup`. The flags are additive like `breakage` — the attempt keeps
its merged/closed/reverted state and still counts its merge — and the
fold adds them to the cell's `dirty`/`fixups` totals, so those rates and
the dirty/fixup improvement patterns finally see fleet evidence instead of
only the dispatch log's exclusive `dirty`/`fixup` outcome states.
Non-required check observations, plain retry requests, pending checks and
PRs no verdict claims unambiguously contribute nothing, and absent, empty
or unmatched evidence changes nothing. `phm fleet outcomes` reads the
ledger's bounded tail by default (`--merge-events <file>` overrides) and
passes the fold; `phm improve discover`'s fleet-learning backlog items read
the same bounded tail (`mergeEventsPath` overrides the
`<runsDir>/metrics/merge-events.jsonl` default) so the dirty/fixup
improvement patterns reach the self-improvement backlog. `phm select` and
the fleet context pack do not consume the friction fields and pass
nothing.

Dead-attempt evidence names why an attempt produced nothing, additively
like the friction flags — the attempt keeps its `closed` state while the
cell's named-cause counts record the reason. An `empty: true` finish
counts the cell's `emptyFailures` only when its empty class is
infrastructure failure: the recorded `empty_class` when it carries the
closed vocabulary, else re-derived from the row's own `exit_code` and
`pool_error` exactly like dispatchd's `classify_empty` — a pool error or
nonzero exit is `error`, a clean zero exit is the healthy `no_diff`
no-op, and a missing exit status is `unknown`. No-op and capture-gap
empties never count, matching the lane penalty's rule that only
infra-failed empties are evidence. A `launch_failed`/`launch_terminal`
row — `retry` and `give_up` actions alike, on a solo job or a dead batch
session closing its member attempts — resolves its open assign as
`closed` and counts the cell's `launchDeaths`; batch-member
`task_outcome` requeues and reverted closes are not launch deaths, and a
requeued relaunch is a fresh assign exactly like the attempt count
already treats it. `emptyFailureRate`/`launchDeathRate` report each
count over the cell's attempts; both are jobs-ledger evidence only — the
dispatch log carries no such rows, so dispatch-dialect cells report 0.

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

`learnedSeatPenalty` turns the same posterior means into seat-router penalties
for one (job type, repo) cell. `learnedFleetSeatPenalty` pools every recorded
cell per resource across models, job types and repos because a seat-router
request carries no fleet job type or repo. It scores the posterior good-merge
rate and includes an allowance cost factor only when every pooled resource
has at least one recorded allowance reading. The cost factor uses the sum
and count of those readings. Jobs-ledger token totals and imputed usage
contribute no allowance evidence. When any resource's allowance is unknown,
all resources are scored on the posterior good-merge rate alone.
Both normalize the same way: the best resource's penalty is 0 and every other
resource's stays inside [0, 1].

`learned-seat-evidence.ts` is the production join that was missing: it reads
the same bounded evidence `phm fleet outcomes` folds — the dispatch event
log (first readable canonical candidate, whole file capped at 8 MiB) and the
jobs-ledger tail (`ROUTER_OUTCOME_LEDGER_LIMIT`), plus the standing revert
keys and the router censor config — through synchronous bounded readers, and
hands `routeSeat` the pooled penalty and a one-line provenance note via
`LeaderSeatDeps.route` (`loadDefaultLeaderSeatDeps`). The result is cached
for `LEARNED_SEAT_EVIDENCE_TTL_MS` (15 minutes) because planning calls
`route` once per seat variant; a changed `ASHLR_RUNS_DIR` invalidates
immediately. Every read failure degrades to `{ learnedPenalty: {} }` —
missing, unreadable, oversized or non-regular files contribute nothing, so
with no usable evidence the seat ranking is byte-identical to the weights
alone and no note is appended. Penalty keys are fleet resource names; a seat
whose id does not match a recorded resource simply takes no penalty.

## Improvement jobs

A failure pattern becomes an improvement job when it has happened at least
three times and, for a low merge rate, good merges are the minority. The
`revert` pattern counts the cell's `reverted` attempts — merges the fleet's
own evidence proved did not hold — so recurring undone merges surface as
improvement work even when the cell's held-merge rate looks healthy; its
rate is the share of the cell's attempts that resolved `reverted`. The
`dirty` and `fixup` patterns count both the dispatch log's exclusive
outcome states and the merge-queue friction flags above, so recurring
merge conflicts and required-check failures surface as improvement work
even though every affected attempt still merged. The `empty-failure` and
`launch-death` patterns count the dead-attempt evidence above at the
same three-attempt threshold, so a seat that repeatedly produces
infrastructure-dead finishes or loses launches before a run starts
surfaces as named work — with the low-merge pattern still firing
alongside when good merges stay the minority. The jobs are data. This
module does not enqueue them, spend, or merge.

## Surfaces

`phm fleet outcomes` and `phm fleet outcomes route` print the view. `--json`
is the same object the desktop imports from
`desktop/outcome-learning-view.ts`. The fleet context pack
(`phm fleet context-pack build`) folds the same two sources through
`learnFleetOutcomes` for its `finished` count — the dispatch log alone
carries no stamped outcome lines, so the jobs-ledger tail is what makes the
count real; a missing or unreadable ledger degrades to dispatch-log
evidence and `sources.metrics` reports the ledger's health. Its `merges`
section reads the same ledger tail for MERGED verdicts (reconciler terminal
rows and the merged/outcome dialects, newest first, one row per job with
job, PR, repo, lane and stamp) ahead of any stamped merge lines still
present in the events log; without the ledger the section keeps only those
stamped lines. A verdict whose recorded revert evidence proves the merge
did not hold carries `reverted: true` — the same two sources and era rule
the outcome folds apply: in-ledger revert evidence (`hasRevertEvidence`)
stamped at or after the verdict's own stamp, or a standing
`owner/repo#n` key from `improve/revert-outcomes.jsonl` claimed by exactly
that job through the verdict row's own PR URL. Revert evidence older than
the verdict belongs to an earlier merge era and leaves the merge a fresh
held merge, absent or unmatched keys change nothing, a contested or
foreign claim never resolves, and a verdict with no job id stays unmarked
rather than guessed.

## Skill-use report window

`ReadSkillRecordsOptions.asOfMs` is an optional inclusive upper bound in
Unix milliseconds for bounded ledger reads. The reader excludes UTC
partitions starting after that bound and rows timestamped after it before
applying file and row limits or checking skill-use event-ID conflicts.
Complete corpus reads ignore the window options. Fleet status and skill
outcome reports supply their report timestamp as the upper bound.
