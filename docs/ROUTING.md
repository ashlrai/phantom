# Typed routing decisions

`phm route decide --input <file|-> [--root <directory>] --json` returns an
advisory `route.decision.v1` report. It never launches a job, reserves capacity,
changes lane targets or overrides admission. `--root` defaults to
`$ASHLR_RUNS_DIR`, then `~/.ashlr-runs`.

## Copy-paste offline example

This uses disposable snapshots and one candidate, so no model call is needed.

```sh
route_demo=$(mktemp -d)
mkdir -p "$route_demo/queue"
cat > "$route_demo/models.json" <<'JSON'
{"codex.work":"gpt-6-sol","effort.codex.work":"high"}
JSON
cat > "$route_demo/queue/slots.json" <<'JSON'
{"codex-personal":{"target":2,"hard_cap":2}}
JSON
cat > "$route_demo/queue/admission.json" <<'JSON'
{"admit":true}
JSON
cat > "$route_demo/request.json" <<'JSON'
{"task_class":"bug-fix","repo":"phantom","tier_hint":"work","lane_candidates":["codex-personal"],"quota_state":{"codex-personal":"available"},"machine_state":{"admit":true,"running_by_lane":{"codex-personal":0}}}
JSON
phm route decide --input "$route_demo/request.json" --root "$route_demo" --json
```

From a source checkout, substitute `npm run dev -- route decide` for
`phm route decide`. Use `--input -` to read the same JSON shape from stdin.
Exit codes: 0 for a report (including deterministic fallback or no eligible
lane), 2 for usage/schema errors, 1 for unreadable input or an internal failure.
Errors are fixed JSON objects and never echo input or provider errors.

## Request and eligibility

See [Failover chains](#failover-chains) for optional job constraints and fallback planning.

## Failover chains

`phm route failover --input request.json --failed-lane seat --failure quota --json`
plans and selects without launching anything. Optional `--attempted a,b` skips
previous attempts; `--root` selects snapshots; `--record` requires request `job`
and appends a receipt to `metrics/jobs.jsonl`. Exit 0 selects a lane, 2 refuses.
All plans are `advisory:true`, `live:false` with `failover_dispatcher_unwired`.

Optional request fields: `job`, `needs` (at most 32 capability names),
`min_tier`, `max_cost_class` (local/included/metered), `data_class`
(public/internal/confidential/restricted), and up to three unique pins:
`"fallback":[{"lane":"backup","on":["quota","5xx","timeout","near_reset"]}]`.
Pins preserve order but never bypass gates. Without pins, eligible candidates
use the existing reset-first ranking; chains have at most three lanes and
never include the primary. `fallback_pinned` / `fallback_ranked` identifies
the source; `fallback_chain_empty` identifies an empty chain.

Every lane must pass admission, available quota, valid slots/model/capacity,
no hold, known running count and unsaturated slots, plus speed/mode adequacy.
Job gates require advertised capabilities, adequate tier_hint and advertised
slot tiers, cost at or below the ceiling, and sufficient data clearance
(missing clearance means public). Failover defaults to an included cost ceiling:
metered requires explicit `max_cost_class:"metered"`. Unknown cost/tier/capacity
fails closed. Capacity needs `observedAt` ISO evidence no older than 900 seconds
(at most 5 seconds future skew), non-null remainingPercent or positive credits,
and no passed reset. Zero remaining without credits is exhausted. Local lanes
codex-local/omlx require explicit pins. Primary selection is unchanged.

Exclusions include `admission_blocked`, `quota_unavailable`, `slot_invalid`,
`held`, `running_unknown`, `saturated`, `model_invalid`, `capacity_invalid`,
`tier_inadequate`, `missing_capability`, `tier_below_minimum`,
`tier_unavailable`, `tier_unknown`, `cost_class_unknown`, `cost_class_exceeded`,
`data_class_exceeded`, `capacity_unknown`, `capacity_stale`, `capacity_exhausted`
and `local_opt_in_required`. Selection skips attempted/failed lanes and mismatched
`on` kinds, returning `failover_quota`, `failover_5xx`, `failover_timeout` or
`failover_near_reset`; refusal returns `fallback_chain_exhausted`, plus
`failure_unknown` for an unsupported failure kind.

The pinned live dispatcher is NOT connected. A separately reviewed/re-pinned
integration must classify failures, retain the original chain/attempt history,
recheck fresh policy/admission/quota/capacity before every attempt, enforce
single-job execution and bounded retries, and append receipts. No plan or CLI
receipt is permission to spend, install or launch. Explain exposes nullable
`fallback_chain` and the last three matching job receipts as `fallback_used`.

The request requires `task_class`, `repo`, `tier_hint`, `lane_candidates`,
`quota_state` and `machine_state`, with optional `mode`. Task classes use the existing
[Jev vocabulary](JEV-INTEGRATION.md). Tiers are `frontier`, `work`, `mid`,
`fast`. Unknown fields, malformed identifiers and unknown tiers are rejected.
At most 64 lane candidates and 32 KiB of input are accepted.

Quota entries are `available`, `exhausted` or `unknown`. Only `available`
candidates qualify. Machine state requires a boolean `admit` and an explicit
nonnegative `running_by_lane` count for each eligible lane. Optional telemetry
is `load1`, `procs`, `worktrees` and `tick_age_s`; it cannot waive admission.
The caller supplies current evidence; this command cannot prove its freshness.

Registry reads are bounded to 1 MiB per regular file and refuse symlinks.
Both request and `queue/admission.json` must say `admit: true`. Missing or
malformed admission fails closed. `queue/slots.json` provides each lane's
`target`, `hard_cap`, optional `effective_target` and `held` flag. Held lanes
and lanes whose running count reaches any applicable cap are excluded.

`models.json` resolution matches launcher precedence: `<pool>.<tier>`,
`<pool>`, `<family>.<tier>`, `<family>`. Codex pools inherit `codex`, except
`codex-local`, which must have its own local model. Effort resolves from
`effort.<pool>.<tier>` then `effort.<family>.<tier>`, defaulting to `xhigh` for
frontier and `high` otherwise. Invalid configured model/effort values exclude
the candidate. Adaptive targets remain owned by dispatchd; this service reads
the effective slot/admission projection and never recomputes or writes it.

## Mode tiers and spend order

A job requests `"mode":"lite"`, `"normal"`, `"ultra"` or `"fusion"` in its
route request. Mode is a capability/cost class independent of company,
transport and queue scope (`tier_hint` stays `frontier|work|mid|fast`). A CLI
subscription seat, API key, Devin cloud/CLI resource or loopback model can fill
any class it qualifies for. Lite covers small efficient models; normal covers
Opus 5.5 / GPT-6.2 Sol peers; ultra covers Fable 5.2 / Astra 6.2 peers. Fusion
returns `route.pairing.v1`: an ultra lead plans/reviews and lite/normal
sidekicks implement. Missing roles stay null; no single-model downgrade occurs.

Exact known model classifications live in
[`model-mode-data.ts`](../src/core/run/model-mode-data.ts). Catalog entries
expose `modeTier`; single-route decisions expose `requested_mode`, selected
`mode_tier` and nullable `capacity` evidence. Unclassified models cannot satisfy
an explicit mode. Classify a custom connected model in `models.json`, for
example `"mode.my-loopback-model":"normal"`. Eligibility still requires
quota, admission and a free slot. Model identifiers can contain `:` and `/`.

Optional `queue/route-capacity.json` maps lane IDs to readings, for example:

```json
{"seat":{"resetAt":"2026-11-18T12:00:00Z","remainingPercent":1},"loopback":{"resetAt":null,"remainingPercent":null,"costPerMTok":0}}
```

Among lanes satisfying the requested minimum class, spend the allowance with
the closest future reset and positive remainder first (even below the calendar
margin), then zero-cost capacity, then lowest known marginal `costPerMTok`
(USD/M tokens). Missing cost is unknown, never inferred free from a subscription
catalog price. Stale/exhausted allowance is excluded unless positive
`creditBalance` remains. Invalid lane readings exclude that lane; missing
snapshots supply no evidence. Callers own snapshot freshness.

A lane may also carry `burnPerHour`, the measured window percent burned per
hour. With it the router knows the lane's runway (`phm pool runway`). A lane
that will run dry before reset (`starve`) takes only frontier work, or a job
kind that merges at least 0.3 PRs per launch over the last 24 hours, as `phm jobs yield` reports.
Other work goes elsewhere and prefers lanes that will reset with usage left (`spend`).
Without a burn rate the runway is unknown and changes nothing.

Explicit modes resolve deterministically without decision-model calls; reasons
include `mode-tier`, `reset-pressure`, `free-capacity`, `cheapest`, or `cost-prior`
when marginal price is unknown. Equal
economic priority falls back to ordinal model cost/latency priors and lane ID.
Without a mode, legacy queue-tier adequacy and bounded decision backends remain.
Backend output cannot override a better evidenced spending opportunity.

Save a job's route request as `queue/route-request.json`, then run
`phm route explain --json`: its nullable `decision` shows the selected tier,
reason codes and allowance/cost evidence (or the fusion pairing). Explanation
recomputes from local snapshots with zero model calls. Missing/invalid requests
yield `decision: null`; existing hysteresis and quality fields remain available.

## Legacy adequacy, cost and latency priors

The directive's table is encoded as ordinal preferences, with no invented
dollar prices or measured latency. The checked-in
[router benchmark](../benchmarks/router-eval/baseline.md) measures historical
lanes; it does not establish comparative Sol/Sonnet/Astra/Fable model latency.

| Models | Speed tier | Cost / latency preference |
| --- | --- | --- |
| Lite models (including Sonnet) | everyday | 1 / 1 |
| Normal models (including Opus, Sol) | workhorse | 2 / 2 |
| Astra, Fable | premium | 3 / 3 |
| Other configured models | tier hint | unknown, sorted after known priors |

`frontier` requires premium, `work` requires workhorse or premium, and
`mid`/`fast` accept everyday or above. After spend order, fallback sorts by
cost rank, latency rank, then lane ID. No low-effort route is invented;
each complete candidate tuple comes from the registry. Unknown model priors
are advisory policy defaults, never evidence of quality or free funding.

## Backend order and failure behavior

For multiple eligible candidates, the service asks local `fast` at
`http://127.0.0.1:8123/v1`, using the existing strict streaming client with
redirects refused, tools disabled and bounded request/response bytes. The
complete tuple is schema-validated and must match an eligible candidate.
Invalid output gets one schema retry across the whole chain. Further invalid
output escalates to the existing cheap Jev `resource-choice` client, then local
`strong`. A valid answer ends the chain. Availability, timeout, throttling,
budget or confidence failures go directly to deterministic fallback; they do
not generate extra paid retries.

Jev uses existing enablement, confidence threshold, kill switches, credentials,
call-count budget, cache and accounting. Local stages honor
`ASHLR_CLASSIFY_DISABLE` and `ASHLR_JEV_DISABLE`. Only bounded task class and
tier plus candidate policy metadata reach Jev, using ordinal choice IDs. No
repository identifier, prompt body, account name or machine telemetry is sent.

All stages share a 450 ms service budget: local attempts get at most 100 ms,
Jev gets at most 120 ms. There are at most four attempts. A client that ignores
abort still loses the race against the deadline. File reads, module loading,
CLI startup and host scheduling are outside this model-service budget; live
sub-500 ms end-to-end latency needs measurement on the deployed host.

Reports contain `lane`, `model`, `mode_tier`, `requested_mode`, `capacity`, `effort`, `speed_tier`, fixed `reason_codes`,
`path`, `duration_ms`, `attempts`, `candidate_count`, `schema` and `advisory`.
With no eligible candidates the four route fields are all `null`; there is no
synthetic runnable lane. No candidates or one candidate means zero model calls.

## Lane capability fit

`phm route fit --input <file|-> [--worktree <directory>] --json` answers one
question before a launch slot is spent: can this lane's sandbox do this job?

Each lane declares four capabilities: `gh`, `network`, `browser` and
`local_fs_outside_worktree`. A value is `true`, `false` or unknown. Today the
only declared fact is that `claude` has no `gh`: its sandbox cannot read the gh
config. Only a declared `false` refuses a route. Unknown is reported in
`unknown` and is never treated as proof either way.

The request is `{job, lane, prompt, candidates?, gh_context?}`. What the job
needs is inferred from the prompt with fixed patterns: `gh pr`, `gh run` and
`gh api` commands, requests to list open PRs, and requests to read failed-run
logs. The fleet CONTEXT block and sentences that forbid a tool are not needs.
No model is called.

The `route.fit.v1` report has `decision`, a typed `code` and one plain `line`:

| decision | meaning |
|---|---|
| `route` | The lane can take the job. |
| `route_skip` | The lane lacks a capability. `code` is `route_skip: lane lacks gh`; `next_lane` is the first candidate that can take it, or `null`. |
| `route_with_pack` | The lane lacks gh, but a gh context pack covers the job's read-only needs. |

### gh context pack

For a job that only reads PR or run data, the dispatcher fetches that data
outside the sandbox and passes it as `gh_context`
(`{repo, prs?, failed_run?}`) with `--worktree`. Phantom scrubs and bounds it,
writes `.ashlr/gh-context.json` in the worktree and returns `pack.prompt_note`
to append to the prompt. The note tells the worker to read the file instead of
calling gh, so no credential enters the sandbox. A section that was not
supplied is `null` (unknown), not an empty list. A pack never covers a gh
write such as `gh pr comment`; those jobs still move to another lane.

`phm queue --json` shows the same check for every ready job under
`routeSkips`. Wiring the check into the live dispatcher is a
[proposal for Security](proposals/lane-capability-route-fit.md); until it is
pinned, nothing here changes a launch.

## Dispatcher observation

The repository dispatcher samples the first valid ready row of each tick
against its post-tick snapshots, with task class `other`. It invokes the fixed
`~/.local/bin/phm route decide --input - --root ~/.ashlr-runs --json` command
with a 0.9-second subprocess timeout. Held/backed-off pools project exhausted
quota; other pools project available quota. This is an observation of dispatcher
state, not an independent provider quota probe.

It appends an allowlisted `route.explain.v1` record to
`metrics/route.explain.jsonl`. Observed decisions include the five typed fields
and bounded latency/attempt counts. Missing CLI, invalid output and timeout
record `status: unavailable`. Provider text and request bodies are never
persisted. Audit errors cannot hold admission. Decisions never feed launch,
lane targets, queue edits or model selection in this change.

No live dispatcher is installed by this change. Installation follows the
existing [dispatcher review and pin workflow](../contrib/mac/README.md#installing-the-dispatcher).
`phm route explain --json` adds the optional job `decision` to its hysteresis report.

### Advisory lead/sidekick pairing

The report's `pairing` field is a typed `route.pairing.v1` advisory decision,
not dispatch authority. Optional `<runs>/queue/pairing-lanes.json` supplies
`{ "lanes": [{ "lane": "lead", "laneClass": "frontier", "available": true,
"pool": { "pool": "lead", "resetAt": null, "remainingPercent": null } }] }`.
Lane classes are `frontier` or `cheap`; pools may also carry `creditBalance`
and marginal `costPerMTok`. Lanes may carry `model` and `mode_tier`; an explicit
mode must agree with its lane class (ultra frontier, lite/normal cheap).
Missing or invalid input yields `pairing: null`; an empty list yields unassigned roles.
Existing runs snapshots do not publish this lane-class/calendar combination.

The pure `decidePairing(lanes, nowMs, { bottleneck })` contract assigns frontier
`plan`/`verify` and cheap `implement`, ordering each class by closest reset,
then free capacity, then cheapest; absent cost falls back to the calendar order.
Reasons are closed:
`reset-pressure`, `credits-only`, `no-capacity-evidence`, `no-frontier-lane`,
`no-cheap-lane`, `implement-escalated`, `paired`, `free-capacity`, `cheapest`. Only an explicit `implement`
bottleneck permits a second frontier lane to implement; route explain declares
no bottleneck. Assignments include reset, remaining allowance and burn pace;
unknown evidence is null, never invented capacity.
Zero remaining or stale allowance excludes a lane unless positive credits remain.
Positive allowance with a future reset is `reset-pressure` even when burn pace is zero.

## Recorded job outcomes

`phm router outcomes [--json] [--runs-dir <dir>] [--lane <lane>] [--limit <1..1000>]`
reads the newest bounded tail of `<runs-dir>/metrics/jobs.jsonl` (default
`ASHLR_RUNS_DIR`, then `~/.ashlr-runs`; 16 MiB retained) joined with the
same bound of `<runs-dir>/metrics/api-spend.jsonl`,
`<runs-dir>/metrics/work-market.jsonl` and
`<runs-dir>/metrics/empty-tags.jsonl`, and reports one
`router.outcome.v1` record per job in that window, newest
first: merge and revert state, CI first pass, review findings, cost, wall
time, recorded merge latency (`ttm_s` — the jobs-ledger `ttm_s`/`ttmS`
opened-to-merged seconds, taken only from the row that stands as the
merge verdict and cleared when a later verdict is not a merge), recorded
token usage (`tokens_total` — the finish row's `tokens_total`/`tokensTotal`
usage total, newest explicit row wins like `cost_usd` and `wall_s`), the
rest of the finish row's recorded usage block — `acus` (the Devin lane's
billed ACU spend, a different unit than `cost_usd` and never summed with
it), the token breakdown `tokens_in`/`tokens_out`/`tokens_cache_read`/
`tokens_cache_write`, and the bounded provenance labels `usage_source`
(the recorded measurement path) and `usage_missing` (the recorded
capture-gap reason) — plus the finish row's recorded diff size
(`diff_files`/`diff_lines`; `diff_lines` stays `null` when untracked
files made the line total unmeasurable),
`work_class`, the finish-row productivity verdicts (`empty`,
`exit_code`, `failure_class` — the recorded failure
classification, resolved `failure_class` → `failure_reason` →
`pool_error` on a finish row so non-devin lanes' causes join too, or
the fixed `reason` on a `launch_failed` row whose `action` is
`give_up` — the dead launch's recorded cause; retry receipts and
`launch_terminal` rows never join — and `empty_class`,
the row's recorded empty-diff classification in dispatchd's closed
`classify_empty` vocabulary `no_diff`/`error`/`unknown`; explicit row
fields only, `null` when unrecorded), the batch member's recorded
`task_outcome` word (a `task_outcome` event row's `outcome` in
dispatchd's closed `batcher.OUTCOMES` vocabulary
`done`/`skipped`/`failed`/`deferred`/`unreported` — the member's finish
boundary, since batch members get no per-member finish row), the
dispatch claim's recorded lane override (`lane_hint`/`lane_override` —
the pair a `claim`/`batch_claim` row writes when the launch left its
hinted lane: the preferred lane left and the recorded reason, the work
market's `resource_fit`/`unknown_preference`/`preferred_lane_fallback`
codes or `batch_session` for a member that moved lanes with its
session; the newest claim stands, so a later on-hint claim clears an
earlier override, and advisory `failover` receipts never join) and the
advisory `passk` join from
`eval.lane-scores.v1`. Batch sessions fold per member like the sibling
fleet readers: `RQ-BATCH-*` session rows — the bundle's launch, finish
and session-aggregate usage — are infrastructure evidence counted in the
report's `session_rows`, never outcomes and never PR-URL claims, while
members fold through their own `batch_claim`/`task_outcome`/publish rows.
Member finish verdicts and usage stay `null` rather than split from the
session aggregate. `work_class` is the class a jobs row recorded when
one exists; otherwise it is the job's newest `work-market.v1`
`route_decision` class — the market's own classification of the job,
written for every evaluated job — and stays `null` when neither ledger
recorded one. The market read
degrades independently: the report's
`market_state` mirrors the jobs `state` vocabulary and `market_truncated`
marks a cut decision tail, in which case joined classes cover only the
newest bytes. The same newest-decision collapse also joins the market's
recorded routing verdict — `market_lane` (the row's `chosen_lane`,
`null` inside a recorded decision that routed nowhere),
`market_preferred` (`preferred_lane`), `market_override` (the override
object's recorded `reason` — `resource_fit`/`unknown_preference`/
`preferred_lane_fallback`) and `market_reasons` (the row's
`reason_codes`, deduplicated in the bounded reason-code shape and
capped) — under the same `market_state` health and newest-decision
rule: a missing field stays `null`, a recorded empty reason list
stays `[]`, and decision rows naming jobs outside the jobs window
never create outcomes. `lane_hint_blocked_by` carries the dispatch claim's
recorded lane-hint blocking codes — the third field of the claim's
lane-override record: a solo `claim` row that left its hinted lane
spreads the work market's `preferred_lane_blocked_by`, the rejected
preferred lane's `reason_codes` or `[]` when the lane was unknown to
the market or merely outranked rather than rejected (`resource_fit`,
`unknown_preference`, hysteresis-held fallbacks); `batch_claim` rows
never carry the field. The list joins only alongside a well-formed
`lane_override` on the newest `claim`/`batch_claim` row under the same
newest-claim-stands rule — a later on-hint claim clears it, a malformed
reason or hint skips the row, and non-claim rows never touch it.
Entries join only in the bounded lowercase reason-code shape,
deduplicated in recorded order and capped; a non-array value or a list
whose entries are all unrecognizable reads as unrecorded (`null`),
while a recorded empty list stays `[]` — the market's own "nothing
blocked it" verdict, distinct from missing evidence. `skipped`,
`skip_reason` and `skip_code` carry the skip gate's recorded launch
decline: dispatchd's `empty_gate`/precheck skip paths write
`skipped_empty` rows (`precheck_skip` is the spelling the sibling fleet
readers honor for the same receipts), and a row whose `applied` is not
`false` marks the standing decline — the fleet chose not to launch the
job. A dry-run receipt (`applied:false`) records the job still
launched, so it never mints a decline and supersedes a standing one;
a later `claim`/`batch_claim`/`launch` dispatch row supersedes it the
same way, while `finish`/`publish`/`outcome` rows never touch the
verdict. The newest skip row replaces the record wholesale:
`skip_reason` is its recorded label (`reason`, then `empty_reason`,
then `skip_reason`, with a bounded-string `code` as the last resort —
accepted only in the bounded identifier-label shape) and `skip_code`
its recorded gate code (`code`/`precheck_code` as a non-negative safe
integer; a string `code` joins `skip_reason` instead).
`dupcheck_skip` never joins — its paired `skipped_empty` row already
carries the canonical decline — and all three stay `null`/`false` when
no skip receipt stands, distinct from the finish row's measured
`empty` no-diff verdict, the member's `task_outcome` word and terminal
no-op phases. `deferred`, `defer_reason` and `defer_repeat_of` carry
the fleet's recorded keep-queued launch verdict: dispatchd's launch
loop writes `dispatch_deferred` when a ready line's request digest is
already covered by an earlier job's claim (`duplicate-request`, the
covering job under `repeatOf`), `recut_admission` rows carry the recut
coverage verdict under `action` — `defer` marks the standing deferral
(`recut-in-flight`, the in-flight or merged prior under `repeatOf`)
while `ready`/`skip` resolve the blocker — and `precheck_parked` marks
the precheck park (the bounded park reason under `reason`, no cover).
The verdict competes with the other launch-decision rows on row order
like the skip decline: the newest keep-queued receipt stands until a
later `claim`/`batch_claim`/`launch` dispatch row or a skip-gate
decline — the fleet's newer recorded decision about the same queued
job — supersedes it to `false`, while `finish`/`publish`/`outcome`
rows never touch it and an unrecognized recut `action` leaves it
alone. `defer_reason` is the newest defer row's recorded label
(`reason`, then `defer_reason`, in the bounded identifier-label
shape) and `defer_repeat_of` its recorded covering job
(`repeatOf`/`repeat_of` in the bounded job-id shape); both join `null`
when unrecorded or malformed and clear with the verdict — all three
stay `null`/`false` when no keep-queued receipt stands, distinct from
`skipped` (the skip gate's decline), `task_outcome` `deferred` (a
batch member's requeue word) and queue waits that write no receipt.
`empty_tag` is the fleet's recorded WHY for a job that
ended empty — the `job.empty-tag.v1` rows `phm jobs empty --record`
appends to `metrics/empty-tags.jsonl` from empty-final-reason's verdict
(src/core/fleet/empty-tags.ts): the closed
`already_done`/`pool_cap`/`blocked`/`no_change_needed`/`unknown`
vocabulary. The newest tag row for the job stands (the recorder dedups
by job id); the tag attaches regardless of the standing finish verdict —
it is the fleet's post-hoc triage of the job's final output, distinct
from the finish row's own `empty`/`empty_class` measures — and rows
naming jobs outside the jobs window never create outcomes. Only rows
with the exact schema, a bounded job id and an in-vocabulary tag join;
malformed rows, other schemas and unrecognized tags are skipped, never
recorded raw. The tags read degrades independently like the market and
spend joins: the report's `empty_tag_state` mirrors the jobs `state`
vocabulary and `empty_tag_truncated` marks a cut tags tail, in which case
joined tags cover only the newest bytes; anything but `read` leaves
every `empty_tag` `null` — unknown, never a guessed cause — while a
recorded `unknown` tag stays distinct from missing evidence. `cost_usd`
is an explicit `cost_usd`/`usd`/`cost` field on a jobs row when one is
recorded; otherwise it is the sum of api-spend call costs naming the job
(same `job`/`job_id`/`id` attribution and `cost_usd`/`usd`/`cost`
precedence the fleet spend readers use). jobs.jsonl finish rows carry
`cost: null` by design, so the spend join is what populates real cost
evidence; a job whose calls reported no cost stays `null` — unknown,
never zero — and `cost_estimated` calls still count because they report a
USD figure. The spend read degrades independently: the report's
`spend_state` mirrors the jobs `state` vocabulary and `spend_truncated`
marks a cut spend tail, in which case joined costs are lower bounds. `reverted`
folds explicit revert evidence — a `reverted` boolean, a revert event name
or terminal REVERT/REVERTED state, or a parseable `reverted_at`/`revertedAt`
stamp — plus the authority ledger's verified evidence index: a
`revert:landed` row undoing a `merge:landed` landing marks the merged PR's
outcome reverted when the job's own canonical github.com pull URL claim is
unambiguous (ambiguous, foreign or non-canonical claims never mark). The
index join reads `ledgerSnapshot('cached')` lazily, contributes only
hash-verified rows — a broken chain still marks only its verified prefix —
and degrades to no join on any read failure. Evidence is sticky-true like
metrics-ingest, so a recorded revert is never
contradicted by a later `reverted:false`; it stays `null` when neither
source records anything either way. It is read-only; a missing
ledger reports `state: "missing"` rather than failing, while an unreadable or
non-file ledger exits 1. The ledger is append-only and unbounded, so when it
exceeds the bound the read keeps the newest bytes, drops the cut first line,
and reports `truncated: true` — every count covers the retained window only,
a lower bound on the full history. Merge state reads the jobs-ledger
outcome dialect the sibling fleet readers share: a terminal phase across
`phase`/`state`/`outcome`/`status`/`result`/`conclusion`, or a `merged` /
`closed` event name when no phase field resolves — a resolved phase stays
authoritative over the event name, `mergedAt`/`closedAt` stay the preferred
stamps on terminal rows, and every other spelling resolves nothing. Unknown
fields stay `null` in JSON and
`unknown` in text — the fold never infers a merge from a PR URL or VERIFIED
marker, and a PR URL claimed by two jobs attaches to neither. This is the
per-job evidence surface outcome-driven router analysis reads; it does not
feed weights, ranking or dispatch by itself.

## Advisory router-weight proposals

`phm fleet router-weights [--runs-dir <dir>] [--json]` folds the same
`metrics/jobs.jsonl` outcomes into `router.weight-proposals.v1`: per
`(work_class, lane)` group it compares the observed held-merge rate against a
0.5 baseline and proposes a bounded shift — at least 20 known outcomes per
group, shifts capped at 0.1 and clamped to [0, 1]. Production jobs rows
never carry `work_class`, so groups classify through the work-market join:
each job's newest `route_decision` row supplies the market's recorded class,
while the lane stays the one the job actually ran on in jobs.jsonl. A merged
outcome recorded as reverted counts as known evidence (`reverted_n` reports
the count) but never as a held merge. Groups below the evidence
floor are refused and keep their baseline; `merged: null` outcomes count as
unknown, never as failures, and jobs with no recorded class count as
unclassified. The report also resolves *why* the unknown cohort has no
merge verdict, from the same recorded finish and launch evidence:
`unknown_empty` counts
jobs whose newest finish recorded `empty: true` (the run produced no
diff), `unknown_nonzero_exit` counts jobs whose newest `exit_code` was
not 0 — the two overlap, since a crashed run usually diffs nothing —
`unknown_failure_classes` tallies the recorded failure classifications
(`failure_class`, else `failure_reason`, else `pool_error` on a finish
row, or the fixed `reason` on a `launch_failed` give_up receipt; top
entries first), `unknown_empty_classes` tallies the recorded finish-row
`empty_class` verdicts — dispatchd's `classify_empty` triage, so the
empty share splits healthy `no_diff` no-ops from the `error`
infrastructure share and `unknown` capture gaps the way the
dispatcher's own `empty_error_rate` does — `unknown_task_outcomes`
tallies the recorded batch-member `task_outcome` words (the member's
finish boundary; the requeue words `failed`/`deferred`/`unreported` are
the recorded failure signal, while `done`/`skipped` members still await
their own publish verdict) — `unknown_skipped` counts jobs whose
standing launch decision is a recorded skip-gate decline (a
`skipped_empty`/`precheck_skip` receipt no later dispatch superseded)
and `unknown_skip_reasons` tallies their recorded reason labels (the
empty-gate vocabulary, bounded `code` strings and `code:<n>`
gate-code-only declines, top entries first) — `unknown_empty_tags`
tallies the fleet's recorded empty tags inside the same cohort (the
`job.empty-tag.v1` rows `phm jobs empty --record` stores in
metrics/empty-tags.jsonl, so an empty finish reads with its recorded
cause — work already on master, quota exhausted, blocked on a missing
tool, genuinely no change needed, or the fleet's own unknown — instead
of only the finish row's bare empty flag) — `unknown_deferred` counts
jobs whose standing launch decision is a recorded keep-queued verdict
(a `dispatch_deferred` duplicate-request receipt, a `recut_admission`
defer, or a `precheck_parked` park no later dispatch or decline
superseded) and `unknown_defer_reasons` tallies their recorded reason
labels (top entries first), so a job the fleet recorded keeping queued
reads as explained rather than unresolved — `unknown_market_reasons`
tallies the work market's recorded `reason_codes` for each
unknown-cohort job's newest `route_decision` row — queue-side
diagnostic context for why the market was or was not routing the job
(`no_runnable_lane`, `global_admission`, `hysteresis_*`,
`preferred_lane`/`healthy_capacity`), never a launch decision and
never a reduction of the unresolved remainder — and
`unknown_unresolved` is
the remainder with no
recorded failure signal, no requeue word and no standing skip
decline or keep-queued verdict (finished cleanly awaiting a
verdict, still in flight, or carrying only transient launch receipts). These are counts over the retained window; when the ledger was
not read they are `null`, never zero — and `unknown_empty_tags` is
`null` whenever the empty-tags ledger itself was not read, since an
absent tag journal means tag coverage is unknown rather than zero;
`unknown_market_reasons` is `null` the same way whenever the market
ledger itself was not read. When the ledger exceeds the retained tail the
report carries `truncated: true` and every count covers the newest bytes
only; `market_state`/`market_truncated` report the decision journal's
health and `empty_tag_state`/`empty_tag_truncated` the tags journal's
the same way. Each proposal also carries an `evidence` block folded
from the same known cohort: the group's CI first-pass rate, summed review
findings, mean `cost_usd`, mean recorded `acus` (the Devin lane's billed
spend — a different unit, never mixed with USD), mean `wall_s`, mean
recorded `ttm_s` (merge latency), mean recorded `queue_wait_s` (the
job's queue-admission wait from its arrival stamp to first dispatch —
the same boundaries job-latency's queue_wait phase pairs), mean
recorded `ci_wall_s` (the job's CI wall seconds from its single
recorded `ci_start`/`ci_complete` boundary pair — the same pair the
reward feed's ciWallMs and job-latency's `ci` phase read; a missing,
reversed or repeated pair stays unrecorded, never estimated), mean
recorded `publish_wait_s` (the job's publish-station wait from its
single recorded `finish`/`publish` boundary pair — the same pair
job-latency's publish_wait phase and visit-sync's publish station
read; a missing, repeated or reversed pair stays unrecorded, never
estimated), mean
recorded
`tokens_total` (token
usage), mean recorded `diff_files`/`diff_lines` (change size), the count
of outcomes carrying a `usage_missing` capture-gap label, mean
advisory `passk`, and the dispatch lane-override tally —
`lane_overrides_known` counts the known-cohort outcomes whose newest
claim left its recorded lane hint and `lane_override_reasons` breaks
the count down by recorded reason (`resource_fit`,
`preferred_lane_fallback`, `unknown_preference`, `batch_session`), so a
lane whose merge rate rests partly on rerouted fallback work shows it —
every
figure with its own coverage count, and `null` (never zero) when the ledger
recorded nothing for that signal. The report also tallies usage
provenance across every folded outcome — known, unknown and
unclassified alike, since capture completeness is not merge evidence:
`usage_missing` lists the top recorded capture-gap reasons and
`usage_sources` the top recorded measurement paths, so an operator sees
where usage telemetry is actually broken rather than only that token
coverage is thin. Each proposal's evidence block also tallies the
dispatch lane-hint blocking codes — `lane_blocked_known` counts the
known-cohort outcomes whose standing claim recorded a non-empty
`lane_hint_blocked_by` (the market's recorded `[]` "nothing blocked
it" verdict does not count) and `lane_blocked_reasons` breaks the
count down by recorded code (`quota_exhausted`, `saturated`, `held`,
`lower_rank`, `hysteresis_*`), so a lane whose hinted work keeps
losing to capacity or rank shows the blocking mix behind its off-hint
share. The weight math still moves on
held-merge rate alone; the evidence is context for whoever applies a
proposal, and text output renders it as `name=value(known)` suffixes only
for signals with coverage. The report is advisory-only: it writes nothing, never
touches `weights.json`, and changes no live routing, rank or admission. A
missing or unreadable ledger reports `status: "unavailable"` with null
counts rather than an empty success.

## Revert outcome scan

`phm fleet reverts --repo-dir <dir> --prs <file> [--prs <file>]... [--ref <ref>] [--json]`
produces the `revert.scan.v1` evidence the hold-rate fold reads: it parses
gh-shaped merged-PR exports (`gh pr list --state merged --json
url,number,mergeCommit,mergedAt`) into revert candidates, resolves a local
ref (`--ref`, else `origin/HEAD` then `HEAD` — the caller fetches; the scan
never fetches itself) and runs the 72h-window detector over that checkout's
history. Each in-window revert emits a `RevertOutcomeRecord` — repository,
PR key, merge and revert commits, both times, revert latency and reland
state — and `revertedKeys` is the sorted prKey set a router subtracts from
landed work. The report names the scanned ref and head commit so coverage is
explicit: merges whose 72h window had not closed by the head commit, or whose
reverts landed outside the scanned history, are not claimed. Rows missing a
PR identity or merge commit are skipped and counted, unreadable exports and
duplicate PRs are counted rather than guessed, and a checkout or ref git
cannot read marks the report `degraded` instead of implying a clean scan.
Read-only; it writes nothing and changes no routing by itself.
