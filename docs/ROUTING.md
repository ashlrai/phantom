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

### Gemini 4 and Antigravity

[Gemini 4 Neon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-neon/)
(released Nov 18, 2026; [model card](https://deepmind.google/models/model-cards/gemini-4-neon/))
is adapted from Carbon. Neon is fast enough for everyday frontier-quality work
and is the balanced work choice; choose Carbon for the hardest, long-horizon
tasks and Hydrogen for fast, routine work. These are model recommendations,
not fleet engine admission or merge authority.

Which Google seats reach Neon on included capacity, and the Workspace
`starter-quota` rule, are in [subscription capacity](SUBSCRIPTION-CAPACITY.md).

| Gemini API ID | Router mode | Use | USD / 1M tokens (input / cached input / output) |
| --- | --- | --- | --- |
| [`gemini-4-carbon`](https://ai.google.dev/gemini-api/docs/models/gemini-4-carbon) | ultra | Hardest frontier | $4 / $0.20 / $20 standard; $2 / $0.10 / $10 through Nov 30, 2026 |
| [`gemini-4-neon`](https://aistudio.google.com/docs/models/gemini-4-neon) | normal | Fast frontier/work quality | $3 / $0.15 / $15 |
| [`gemini-4-hydrogen`](https://ai.google.dev/gemini-api/docs/models/gemini-4-hydrogen) | lite | Fast everyday | $1.50 / $0.075 / $7.50 |

Each has a 1,048,576-token API context and a 65,536-token synchronous
output limit. These limits and token prices are for the API/AI Studio,
not Antigravity seat capacity.

The local-first router never adds Gemini API to the default provider chain.
To permit a metered escalation, the owner must add `gemini` to
`models.providerChain`, supply `GEMINI_API_KEY` and explicitly allow cloud
use. Cloud escalation still requires a non-empty escalation reason (other
than `none`), respects local-only mode and tries configured cloud providers in
order, skipping those without keys. If Gemini is selected, it defaults to
Neon; an explicit API model selection can choose Carbon or Hydrogen. A
request failure does not silently buy a retry from another Gemini model.

[`agy` (Antigravity CLI)](https://antigravity.google/blog/gemini-4-neon-in-google-antigravity/)
is a separate Google AI Pro/Ultra subscription seat, never a Gemini API fallback.
Neon is rolling out to paid seats, but the observed `agy` 1.5.3 model listing
did not offer it. Use only IDs returned by the specific seat's `agy models`.
For a seat that does not list Neon, the Gemini-family fallback is a listed
`gemini-4-hydrogen-high` (work) or `gemini-4-hydrogen-medium` (fast), then
a listed `gemini-3.8-flash-*` variant. The checked-in Mac launcher keeps
its pinned choices: `claude-opus-4-6-thinking` for frontier,
`gemini-3.8-flash-high` for work and `gemini-3.8-flash-medium` for fast.
It runs with `useG1Credits=false` and does not inherit API keys; the catalog
refresh does not change those choices or install a launcher.

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

The same journal now feeds the report's `typed_decisions` field: a bounded
`route.typed-decisions.v1` digest (`src/core/router/typed-decisions.ts`)
folds the newest `TYPED_DECISIONS_LEDGER_LIMIT` (8 MiB) of
`metrics/route.explain.jsonl` — `readTypedDecisions({runsDir?, limit?})` for
the file read, `foldTypedDecisions(text, path, truncated)` for the pure
fold. Rows count only under the exact producer contract (schema
`route.explain.v1`, the `route.explain` event, advisory `true`, a finite
epoch-second `ts`, and `status` `observed`/`unavailable`); an observed row
must also carry a decision inside the producer's own allowlist, so a row
the dispatcher could not have written counts as `invalid_rows`, never a
partial pick. The digest reports `records`, `observed`/`unavailable`
counts, top lane/model/reason-code tallies (each capped at eight), mean
and max for the recorded `duration_ms`, `attempts` and `candidate_count`
metrics, and the `oldest_ts`/`newest_ts` window. Malformed metric values
stay unrecorded (`known` counts only well-formed figures; means stay null
when none exist), a missing journal is `state: missing`, and a cut tail
reports `truncated: true`. The rows carry no job identity, so the digest is
fleet-level service evidence only — it describes what the typed layer
decided and how the call behaved, never which job it decided for, and it
routes, weights and applies nothing.

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

The reward feed records merge evidence once both the jobs-ledger receipt time
and the effective merge time have been reached. For merge and close verdicts,
the reward uses the repository identified by the verdict's GitHub PR URL or
its qualified repository field. If the receipt lacks repository evidence,
the feed uses the single distinct repository observed at the latest dispatch
timestamp at or before the outcome. Repository names are case-insensitive.
Missing or conflicting dispatch repository evidence leaves the reward's
repository null when the verdict supplies none.

`phm router outcomes [--json] [--runs-dir <dir>] [--lane <lane>] [--limit <1..1000>]`
reads the newest bounded tail of `<runs-dir>/metrics/jobs.jsonl` (default
`ASHLR_RUNS_DIR`, then `~/.ashlr-runs`; 16 MiB retained) joined with the
same bound of `<runs-dir>/metrics/api-spend.jsonl`,
`<runs-dir>/metrics/work-market.jsonl`,
`<runs-dir>/metrics/empty-tags.jsonl`,
`<runs-dir>/metrics/merge-events.jsonl` and
`<runs-dir>/metrics/launch-cost.jsonl`, plus the reward-signal
substrate under the ASHLR home root
(`<ashlr>/metrics/reward-signals.jsonl`, `ASHLR_HOME` honored), and
reports one
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
`work_class`, the recorded repo cell (`repo` — the dispatcher's
repo name on its queue rows, joining only in the bounded
bare-name-or-`owner/repo` shape with the newest recognized value
winning like `lane`/`model`/`tier`; absolute paths, whitespace and
deeper paths are skipped, never recorded raw, and the field stays
`null` when no retained row recorded one), the finish-row
productivity verdicts (`empty`,
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
session aggregate. Node session-pool rows (`fleet.session-pool.v1`)
resolve job identity by the producer's contract: `job` is the unique
per-attempt id (`<sessionId>:<n>`) and `jobId` the logical queue id the
attempt worked, so only `jobId` keys an outcome — the attempt id never
mints a phantom outcome, `session_start`/`session_stop` carry no job
fields and stay unattached, and a queue job's `session_rotate`/`launch`/
`finish` rows fold into one outcome whether one session or a later
retry ran them. Node-runner finish rows (`phm-node-runner.v1`, the
multi-Mac node pool's pack executor) carry the same dual-id contract —
`job` is the per-claim id (`<jobId>:<token>`) and `jobId` the logical
node-queue id — so only `jobId` keys an outcome, and the runner's
recorded verdict folds as `node_outcome`/`node_id`/`node_pack`: the
producer's closed `succeeded`/`fenced`/`failed` execution word for the
offloaded pack job (result artifacts, never pull requests, so `merged`
stays `null`) plus the node and pack that ran it in the bounded id
shape. `work_class` is the class a jobs row recorded when
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
`preferred_lane_fallback`), `market_reasons` (the row's
`reason_codes`, deduplicated in the bounded reason-code shape and
capped) and `market_rejected` (the row's `rejected_lanes` — the
market's per-lane rejection record, each entry `{lane, reasons}`
joining under the same bounded shapes: a recorded empty list stays
`[]`, a missing or all-malformed `rejected_lanes` reads as
unrecorded `null`, and an entry's `reason_codes` keeps the same
empty-versus-unrecorded distinction) — under the same `market_state`
health and newest-decision
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
`noop`/`noop_reason`/`noop_repeat_of` are the fleet's recorded terminal
no-op verdict: an outcome-phase row whose resolved phase sits in the
canonical empty family the sibling readers share — `DONE-NOOP` (the
live spelling; dispatchd's already-merged/terminal-target admission,
recut-skip and repair-freshness verdicts and restock's precheck
retirements write `{event:'outcome', state:'DONE-NOOP'}` with
`launched:false` and the recorded `reason`) plus the defensive
`EMPTY`/`EMPTY_DONE`/`SKIPPED-EMPTY`/`NOOP` spellings
(`SKIPPED` stays out so a batch member's `task_outcome` word never
mints a job verdict). It is the fleet's recorded "no publishable work
needed" decision — the job never ran because its target was already
resolved — distinct from `empty` (the finish row's measured no-diff),
`skipped`, `deferred` and the merge lifecycle (`merged` stays `null`).
The verdict competes with the other launch-decision rows on row order:
the newest empty-family row marks it with its recorded reason
(`reason`, then `empty_reason`, then `noop_reason`, bounded
identifier-label shape — `already-merged`, `target_pr_merged`/
`target_pr_closed`/`target_pr_conflicts_resolved`/
`target_pr_checks_resolved`, `recut-already-merged`, the precheck
retirement labels) and cover
(`repeatOf`/`repeat_of`, the recut verdict's prior attempt), resolves a
standing `skipped`/`deferred` to `false` (a `null` one stays `null` —
no receipt was ever recorded), and every newer launch-decision receipt
— a `claim`/`batch_claim`/`launch` dispatch, a skip-gate row, a
keep-queued receipt or a `recut_admission` verdict — supersedes it to
`false`; `finish`/`publish`/outcome rows of other phases and
non-decision events never touch it. All three stay `null` when no
empty-family row named the job.
`handoff_trigger`/`handoff_lane`/`handoff_target` carry the fleet's
recorded session-handoff advisory — dispatchd's
`session_handoff_advisory` rows (`session-failover.v1`, the
contrib/mac/session_handoff.py producer mirrored in the fold). The
producer's closed trigger vocabulary has two verdicts:
`rate-limit`, the once-per-attempt receipt dispatchd appends to
jobs.jsonl when a run's log tail matched a usage-limit pattern and
the attempt failed or produced no usable work — the provider wall
that names the lane whose run died, distinct from the finish row's
own exit/empty measures since a walled run can exit cleanly and
still produce nothing publishable — and `quota-exhausted`, the
pending-job verdict dispatchd writes to work-market.jsonl when the
job's lane measured zero quota, carrying the market's chosen lane as
`target`. That market-side copy joins back through the
`foldMarketHandoffAdvisories` read under the `market_state` health:
each job's newest recorded advisory supersedes the jobs-ledger
triple only when its recorded `ts` is strictly newer than the
standing jobs-ledger advisory's parseable timestamp — no jobs
advisory means the market verdict fills the triple, an unorderable
jobs advisory leaves the jobs verdict standing, and market rows
naming jobs outside the jobs window join nothing. This fold keeps
the producer's full vocabulary so a quota-exhausted row landing in
the jobs window still joins under the same rules. The row counts
only on the exact
schema and event name (the `event`/`type`/`kind` alias set) with a
`trigger` inside the producer's closed vocabulary; lane and target
join independently in the bounded lane-identifier shape — a
malformed trigger skips the row, malformed lane/target values drop
to `null` without discarding the recorded trigger. The newest
recognized advisory replaces the triple wholesale; the advisory is
attempt evidence, not a launch decision, so rows of every other
event leave it standing. All three stay `null` when no advisory row
named the job — the retained window recorded no provider-wall
verdict, which is unknown, not "no wall ever".
`provider_wall_trigger`/`provider_wall_pattern`/`provider_wall_lane`
carry the fleet's recorded provider-wall lane hold — dispatchd's
`autobackoff_hold` receipts (jobs.jsonl rows the usage/quota and
auth backoff scanners append when a finished run's log tail matched
a provider error pattern and the lane was held). A hold only lands
on a failed or no-work run — the auth scanner additionally requires
its `auth_failures` streak — so the receipt is the fleet's confirmed
provider-wall verdict for the attempt, covering the auth walls the
session-handoff advisory never sees and the usage walls whose hold
landed where no advisory did. The row counts only on the
`autobackoff_hold` event name (the `event`/`type`/`kind` alias set)
with a `pattern` id in the bounded identifier-label shape — the
payload field every producer hold row carries; the trigger joins in
the fold's closed two-label derivation (`usage-limit` for the
usage/quota scanner's pattern family, `auth-failure` for the auth
scanner's — a recorded `auth_failures` count marks the auth streak
holds outright, and the router keeps its own copy of the producer's
`AB_RX`/`AB_AUTH_RX` pattern tables so a producer-side rename can
never leak an unbounded label), the pattern records the bounded id
verbatim, and the lane joins in the bounded lane-id shape. An
unrecognized pattern still records the hold with trigger `null`
rather than guessing a family; the `autobackoff_skip`/
`authbackoff_skip` helper-unavailable receipts — scans that
recorded no verdict — never join. The newest recognized hold row
replaces the triple wholesale; the hold is attempt evidence, not a
launch decision, so rows of every other event leave it standing.
All three stay `null` when no hold row named the job — the retained
window recorded no confirmed provider wall, which is unknown, not
"no wall ever".
`pool_kind`/`pool_mem_free_pct`/`pool_swap_gb` carry the fleet's
recorded slot-throttle detection — dispatchd's `pool` receipts
(jobs.jsonl rows the per-tick `ratelimited()` scan appends when a
launched job's recent error-log tail matches a provider-limit
pattern). The receipt is scan-time evidence, not a launch or
terminal verdict: the detector fires on a log-tail match for any
job whose `.base` still stands, once per (job, class), so a
recovered run, an in-flight run and a finished run whose finish row
never recorded `pool_error` all carry it. `pool_kind` joins only in
the producer's closed CLS vocabulary (`credits_exhausted`,
`usage_limit`, `model_capacity`, `rate_limit` — the same classes
the finish row's `pool_error` and the friction ledger's quota set
share), `pool_mem_free_pct` the host free-memory percentage (only
inside [0, 100]) and `pool_swap_gb` the host swap figure (only
non-negative) the detector captured at detection time. The row
counts only on the `pool` event name (the `event`/`type`/`kind`
alias set) with a `kind` inside the vocabulary; a malformed memory
reading drops to `null` without discarding the class, and a `kind`
outside it skips the row entirely. The newest recognized pool row
replaces the triple wholesale; the receipt competes with nothing,
so rows of every other event leave it standing. All three stay
`null` when no pool row named the job — the retained window
recorded no throttle detection, which is unknown, not "no throttle
ever".
`node_outcome`/`node_id`/`node_pack` carry the node runner's recorded
execution verdict — `phm-node-runner.v1` finish rows, the multi-Mac
node pool's pack executor receipts (src/core/drive/nodes/runner.ts).
The row counts only on the schema with an `outcome` inside the
producer's closed vocabulary (`succeeded` — the pack completed and
staged its result artifact; `fenced` — the claim's lease was lost
mid-run; `failed` — the pack errored or its result could not be
staged); the newest recognized finish row replaces the triple
wholesale and every other row leaves it standing. The verdict is the
offloaded node-pack job's terminal execution evidence — result
artifacts, never pull requests, so `merged` stays `null` — while
`node_id` joins the row's `node` (the machine that ran the pack) and
`node_pack` its `pack` reference, each only in the bounded identifier
shape (a malformed value drops to `null` without discarding the
recorded verdict). Claim and leader fencing tokens on the same rows
are machinery and never join. All three stay `null` when no
recognized runner row named the job — the retained window recorded
no node execution verdict, which is unknown, not "never ran on a
node".
`empty_tag` is the fleet's recorded WHY for a job that
ended empty — the `job.empty-tag.v1` rows the daemon's
`empty-tag-sync` off-tick job and `phm jobs empty --record`
append to `metrics/empty-tags.jsonl` from empty-final-reason's verdict
(src/core/fleet/empty-tags.ts, src/core/fleet/empty-tag-sync.ts): the closed
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
recorded `unknown` tag stays distinct from missing evidence.
The daemon waits for a finish on or after the job's latest recorded launch
or batch claim before reading its log or recording a duplicate-check outcome.
When timestamps match, ledger order decides which receipt came first.
`merge_queue` is the merge queue's recorded per-PR history for the
job's standing pull request — the `metrics/merge-events.jsonl`
observations the host merge observer and `phm fleet merge-retry`
append (the same ledger `phm fleet merge-latency` reads), joined
through the canonical github.com pull URL on the job's winning merge or
close verdict. An older verdict appended later cannot change the join.
If the winning verdict lacks a URL, the job must have exactly one claimed
PR identity in the retained ledger. Unresolved jobs use the newest
unambiguous canonical claim. A contested or foreign verdict URL leaves
the join unknown. Merge-events rows never create outcomes. `foldMergeEvents` keeps only rows passing the
merge-latency reader's own validation — a `blocked` row needs a
recorded in-vocabulary `reason`, a `check_observed` row a recorded
`conclusion` (with `required` only as a boolean when present), and
every type outside the state/terminal set a parseable `at` — and
collapses them per PR to `events` (qualifying row count),
`blocked_reasons` (distinct recorded blockers in first-seen order),
`conflicts`, `check_failures` and `required_check_failures` (failed
check observations split on recorded `required: true`),
`checks_passed` (recorded all-required-green boundary rows) and
`check_observations` (recorded check observations of any conclusion —
the coverage `check_failures` counts the failure subset of),
`retries`/`retry_failures` (distinct `at`+`head_sha` pairs, so a
replayed append counts once), `recuts` and `auto_merge` (the last
recorded toggle in append order). The evidence is post-publish
queue-side context — it never replaces the jobs ledger's merge
verdict and never feeds routing by itself. The same joined check
record also resolves `ci_first_pass`
fill-only when no jobs row recorded a verdict: any recorded check
failure — required or unrelated — reads `false` even beside a later
`checks_passed` boundary or a merge (a rerun or a new head got it
green, which is not a first pass). A `checks_passed` boundary reads
`true` only in an uncut ledger with zero recorded failures and no
`retry_requested`, `retry_failed` or `recut_requested` receipts for
the PR. Recovery receipts leave the original check attempt unproven.
Individual check observations leave this fallback unknown (`null`)
even when the PR merged. The read degrades
independently like the other side ledgers: the report's
`merge_events_state` mirrors the jobs `state` vocabulary and
`merge_events_truncated` marks a cut merge-events tail, in which case
joined evidence covers only the newest bytes. A cut tail can establish
a recorded failure, but a green boundary alone leaves first-pass CI
unknown because earlier failures may be outside the window. An explicit
jobs-ledger verdict still takes precedence. Anything but `read`
leaves every `merge_queue` `null` — unknown, never a guessed queue
history. `cost_usd`
is an explicit `cost_usd`/`usd`/`cost` field on a jobs row when one is
recorded; otherwise it is the sum of api-spend call costs naming the job
(same `job`/`job_id`/`id` attribution and `cost_usd`/`usd`/`cost`
precedence the fleet spend readers use). jobs.jsonl finish rows carry
`cost: null` by design, so the spend join is what populates real cost
evidence; a job whose calls reported no cost stays `null` — unknown,
never zero — and `cost_estimated` calls still count because they report a
USD figure. The spend read degrades independently: the report's
`spend_state` mirrors the jobs `state` vocabulary and `spend_truncated`
marks a cut spend tail, in which case joined costs are lower bounds.
The reward-signal ledger joins under the ASHLR home root — the same
root the eval passk projection resolves — because it persists resolved
per-job outcome evidence far longer than the bounded jobs tail: the
daemon's reward-sync feed and supervising bridges append one `v:1` row
per terminal job (`jobId`, resolved `merged` verdict,
`dispatchedAt`/`mergedAt`/`recordedAt` stamps, derived
`timeToMergeMs`, `ciWallMs`, and a `cost` block carrying the metered
pool readings). The daemon excludes batch session wrappers (`RQ-BATCH-*`)
and node-pool attempt telemetry from the reward fold. Batch members still
use their own `batch_claim` rows and PR verdicts. The daemon records
`ciWallMs` when the rewarded dispatch
and resolution window contains exactly one distinct CI start and one distinct
completion in order. CI receipts outside that window are ignored when
checking for ambiguity, so earlier attempts can coexist with a measured
retry. A merge uses its recorded merge time even if its ledger receipt
arrived later. The latest effective merge time selects the rewarded attempt.
A revert at or after that merge changes its verdict. The fold uses the
recorded revert time when available and the receipt timestamp otherwise.
Replayed merge receipts cannot restore credit for a reverted merge, and the
original merge time still bounds dispatch and CI evidence.
Missing or ambiguous timing stays unknown, and existing
reward rows retain their original values.
`foldRewardSignals` collapses the bounded tail to
each job's recorded evidence and the read fills only what the jobs
fold left null — `merged`, `ttm_s` (only when both the standing verdict
and the reward row record a merge), `ci_wall_s`,
`cost_usd` (after the api-spend join) and `repo` — so verdicts and
cost figures the retained jobs window dropped rejoin from the
substrate without ever contradicting a recorded jobs-ledger value;
the reward row's `merged:false` covers its closed-unmerged and
reverted resolutions alike (the v1 schema has no revert dimension —
`reverted` still joins independently). `pool_pct_used` is the row's
recorded subscription-pool percentage points consumed
(`cost.pctUsedDelta`) — the only per-job subscription-quota cost
figure, since subscription lanes record no `cost_usd` and `acus`
covers only the Devin lane's ACU spend; it is a different unit than
either and never summed with them, and it stays `null` when the pool
window reset or readings were missing (the producer leaves the delta
null — unknown stays unknown, never 0). Only rows with `v:1`, a
bounded `jobId`, a boolean `merged` verdict and parseable
`dispatchedAt`/`recordedAt` stamps count; consumed fields join under
their own bounded shapes and malformed values drop to `null` without
discarding the row. The read degrades independently like the other
side ledgers: the report's `reward_state` mirrors the jobs `state`
vocabulary and `reward_truncated` marks a cut tail, in which case
joined evidence covers only the newest bytes; anything but `read`
leaves every joined field at its jobs-ledger value — unknown, never
a guessed verdict or cost — and reward rows naming jobs outside the
jobs window never create outcomes. The launch-cost ledger joins under
the runs dir — `<runs>/metrics/launch-cost.jsonl`, the bounded
append-only `fleet.launch-cost.v1` journal the `launch_cost.py`
producer appends and `src/core/fleet/launch-cost.ts` reads for fleet
vitals: the fleet's recorded first-minute process/CPU probe per launch
attempt. `foldLaunchCosts` validates each row under the producer's
closed contract (exact schema, bounded lane/launchId identifiers, the
recorded status vocabulary, metric figures inside their shapes —
`unknown` rows carry none, `measured` rows require nearly-full
60-second coverage with at least 12 samples, and mean CPU never
exceeds peak) and the read resolves each `launchId` to a folded job
id: the producer keys measured rows `<job>-<12 lowercase hex claim
hash>` — one row per attempt — and unknown probes by the bare job id,
so a launchId that is itself a folded job id keys itself (a job id may
legitimately end in a 12-hex segment), a measured/partial row's suffix
strips to the job it measured, and an unknown-status row prefers an
exact job-id match before the stripped prefix. The join fills
`launch_cost_status` (`measured`/`partial`/`unknown` — the probe ran
but recorded nothing on `unknown`), `launch_peak_processes`,
`launch_mean_cpu_pct` and `launch_peak_cpu_pct`, the only per-attempt
resource-cost evidence subscription lanes record since their finish
rows carry no `cost_usd`; the last appended row for a resolved job
stands and rows resolving outside the jobs window join nothing and
never create outcomes. The report's `launch_cost_state` mirrors the
jobs `state` vocabulary and `launch_cost_truncated` marks a cut
tail; anything but `read` leaves every `launch_cost_*` field null —
unknown, never a zeroed or guessed resource figure. `cross_review` is
the cross-provider review gate's recorded verdict for the job's
standing pull request — the bounded append-only
`fleet/cross-review.jsonl` audit journal under the ASHLR home root
(the same root the eval passk projection and reward ledger resolve;
`CROSS_REVIEW_SCHEMA_VERSION` 1 rows written by
`src/core/fleet/cross-review-run.ts`). The journal carries `review`
records — one per cross-model review of a standing PR, keyed
`repo`+`pr` — and `decision` records recording the merge-action the
review informed; `foldCrossReviews` keeps only `kind:'review'` rows
under the producer's closed contract (`schemaVersion` 1, an
`owner/repo`-shaped `repo`, a positive integral `pr`, the
`approve`/`reject`/`failed`/`skipped` outcome vocabulary and a
bounded `at` stamp) and collapses them to each PR's newest verdict —
decision rows, wrong-schema rows, malformed rows and foreign kinds
are skipped, never counted, and the reviewer's pool/family, reasons
and semantic detail stay audit-side rather than joining. The join
resolves each outcome's `cross_review` through the same PR identity as
`merge_queue`. Cross-review rows never create outcomes. The evidence is
review-gate context like `merge_queue`: a `reject` is the recorded
reason the PR may never merge, but a review verdict is not a merge
verdict — the join never feeds routing, ranking, admission or weight
math. The read degrades independently like the other side ledgers:
the report's `cross_review_state` mirrors the jobs `state`
vocabulary and `cross_review_truncated` marks a cut tail, in which
case joined verdicts cover only the newest bytes; anything but
`read` leaves every `cross_review` `null` — unknown, never a guessed
verdict — while an empty readable ledger means zero recorded joins.
`reverted`
folds explicit revert evidence — a `reverted` boolean, a revert event name
or terminal REVERT/REVERTED state, or a parseable `reverted_at`/`revertedAt`
stamp — plus the authority ledger's verified evidence index: a
`revert:landed` row undoing a `merge:landed` landing marks the merged PR's
outcome reverted when the job's own canonical github.com pull URL claim is
unambiguous (ambiguous, foreign or non-canonical claims never mark). The
index join reads `ledgerSnapshot('cached')` lazily, contributes only
hash-verified rows — a broken chain still marks only its verified prefix —
and degrades to no join on any read failure. A second, independent revert
source joins under the same claim rule:
`$ASHLR_HOME/improve/revert-outcomes.jsonl`, the bounded append-only
ledger `phm fleet reverts --record` writes from its 72h-window
git-history scan — reverts of fleet PRs that no jobs-ledger or
authority row ever named. Its newest record per `owner/repo#n` key
decides, so a later detection whose `relandedBy` is set clears the key,
and `revert_ledger_state` reports that ledger's health (`read`/`missing`/
`unreadable`/`too-large`); anything but `read` contributes no keys —
corrupt evidence never marks a merge reverted. Evidence is sticky-true like
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
while the lane stays the one the job actually ran on in jobs.jsonl. If the
newest decision omits the class or records an invalid value, the market
class is unknown. A merged
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
`job.empty-tag.v1` rows the daemon's `empty-tag-sync` job and
`phm jobs empty --record` store in
metrics/empty-tags.jsonl, so an empty finish reads with its recorded
cause — work already on master, quota exhausted, blocked on a missing
tool, genuinely no change needed, or the fleet's own unknown — instead
of only the finish row's bare empty flag) — `unknown_deferred` counts
jobs whose standing launch decision is a recorded keep-queued verdict
(a `dispatch_deferred` duplicate-request receipt, a `recut_admission`
defer, or a `precheck_parked` park no later dispatch or decline
superseded) and `unknown_defer_reasons` tallies their recorded reason
labels (top entries first), so a job the fleet recorded keeping queued
reads as explained rather than unresolved — `unknown_noop` counts jobs
whose standing verdict is the fleet's recorded terminal no-op (an
empty-family outcome phase — `DONE-NOOP` and kin — that no later
launch-decision receipt superseded: dispatchd's
already-merged/terminal-target, recut-skip and repair-freshness
verdicts and restock's precheck retirements, the recorded "no
publishable work needed" decision) and `unknown_noop_reasons` tallies
their recorded reason labels (`already-merged`, `target_pr_*`,
`recut-already-merged`, the precheck retirement labels, `unlabeled`
when the verdict row carried none; top entries first) — so a job the
fleet recorded needing no work reads as explained rather than
unresolved — `unknown_market_reasons`
tallies the work market's recorded `reason_codes` for each
unknown-cohort job's newest `route_decision` row — queue-side
diagnostic context for why the market was or was not routing the job
(`no_runnable_lane`, `global_admission`, `hysteresis_*`,
`preferred_lane`/`healthy_capacity`), never a launch decision and
never a reduction of the unresolved remainder —
`unknown_market_rejected` counts the unknown-cohort jobs whose newest
decision recorded a non-empty `rejected_lanes` list and
`unknown_market_rejected_reasons` tallies the recorded per-lane
rejection codes over the same cohort (each job contributes each code
once however many lanes rejected it for it — the per-lane why behind
`no_runnable_lane`/`global_admission` verdicts, like
`quota_exhausted`, `saturated`, `held`, `provider_backoff`,
`cost_class_*`, the `unavailable` verdicts, `hysteresis_*` and
`lower_rank`) — `unknown_handoffs` counts the unknown-cohort jobs
whose recorded session-handoff advisory is a `rate-limit` verdict
(the fleet's once-per-attempt receipt — the advisory dispatchd
appends to jobs.jsonl — that the run died on a provider
usage-limit wall and produced no usable work, the same kind of
recorded failure signal `failure_class` carries, so it explains the
missing merge verdict), `unknown_provider_walls` counts the
unknown-cohort jobs carrying a recorded `autobackoff_hold` lane
hold (the confirmed provider-wall verdict — it only lands on a
failed or no-work run, so like a `rate-limit` handoff it explains
the missing merge verdict for both trigger families) and
`unknown_provider_wall_triggers` tallies the recorded
`usage-limit`/`auth-failure` families over the same cohort,
`unknown_pool_throttles` counts the unknown-cohort jobs carrying a
recorded slot-throttle detection (dispatchd's `pool` receipts —
the per-tick `ratelimited()` scan's provider-limit class for the
job's recent error-log tail, joined as `pool_kind` in the closed
`credits_exhausted`/`usage_limit`/`model_capacity`/`rate_limit`
vocabulary) and `unknown_pool_kinds` tallies the recorded classes
over the same cohort — scan-time diagnostic context like
`unknown_market_reasons`, never a reduction of the remainder since
the detector fires on a log-tail match for any job whose `.base`
still stands and says nothing about the run's terminal state —
`unknown_node_outcomes` counts the unknown-cohort jobs carrying the
node runner's recorded execution verdict (`phm-node-runner.v1`
finish rows joined as `node_outcome` — the offloaded node-pack job's
terminal verdict in the closed `succeeded`/`fenced`/`failed`
vocabulary; node-pack jobs produce result artifacts, not pull
requests, so `merged` stays null however the pack ended and the
verdict is the job's own answer to "did the work run" — a
`failed`/`fenced` attempt is the recorded failure signal and a
`succeeded` attempt is the terminal success the node path exists to
produce, so all three explain the missing merge verdict) and
`unknown_node_verdicts` tallies the recorded verdict words over the
same cohort (most jobs first) — and
`unknown_handoff_triggers` tallies every
recorded advisory trigger in the cohort (`rate-limit` attempt kills
and `quota-exhausted` pending-lane verdicts — the producer's other
closed-vocabulary trigger, which dispatchd writes to the market
ledger and this fold accepts if it lands in the jobs window; like
`unknown_market_reasons` it is queue-side context, never a
reduction of the remainder) — `unknown_merge_queue` counts the
unknown-cohort jobs whose standing PR carried recorded
merge-events observations (joined as `merge_queue` — the merge
queue's blocked reasons, check failures, conflicts, retries and
recuts for the job's pull request),
`unknown_merge_queue_blocked` counts those whose queue blocked the
PR at least once with `unknown_merge_queue_blocked_reasons` tallying
the recorded blocker codes (each job contributes each reason once,
most jobs first), and `unknown_merge_queue_check_failures`,
`unknown_merge_queue_conflicts`, `unknown_merge_queue_retries` and
`unknown_merge_queue_recuts` count the same cohort's jobs whose PR
recorded at least one of each — queue-side diagnostic context for
what the merge queue was doing with the PR while its merge verdict
stayed unrecorded, never a reduction of the remainder —
`unknown_cross_reviews` counts the unknown-cohort jobs whose standing
PR carried a recorded cross-model review verdict (joined as
`cross_review` — the review gate's `approve`/`reject`/`failed`/
`skipped` answer for the job's pull request) with
`unknown_cross_review_verdicts` tallying the recorded verdict words
over the same cohort (most jobs first) — review-gate context like the
merge-queue join: a `reject` is the recorded reason the PR may never
merge, but a review verdict is not a merge verdict, so it never
reduces the remainder — and
`unknown_unresolved` is
the remainder with no
recorded failure signal, no requeue word, no standing skip
decline, keep-queued verdict, terminal no-op verdict,
rate-limit handoff verdict or node-runner execution verdict
(finished
cleanly awaiting a
verdict, still in flight, or carrying only transient launch receipts). These are counts over the retained window; when the ledger was
not read they are `null`, never zero — and `unknown_empty_tags` is
`null` whenever the empty-tags ledger itself was not read, since an
absent tag journal means tag coverage is unknown rather than zero;
`unknown_market_reasons`, `unknown_market_rejected` and
`unknown_market_rejected_reasons` are `null` the same way whenever the
market ledger itself was not read, the `unknown_merge_queue*`
tallies are `null` whenever the merge-events ledger itself was not
read, `unknown_cross_reviews`/`unknown_cross_review_verdicts` are
`null` whenever the cross-review ledger itself was not read
(`unknown_noop`/`unknown_noop_reasons` and the handoff,
provider-wall, pool-throttle
and node-runner tallies read jobs-ledger rows
only, so they are real
whenever the jobs read succeeded). When the ledger exceeds the retained tail the
report carries `truncated: true` and every count covers the newest bytes
only; `market_state`/`market_truncated` report the decision journal's
health, `empty_tag_state`/`empty_tag_truncated` the tags journal's,
`merge_events_state`/`merge_events_truncated` the merge-events
journal's, `revert_ledger_state` the scan-detected revert ledger's,
`reward_state`/`reward_truncated` the reward-signal substrate's,
`launch_cost_state`/`launch_cost_truncated` the launch-cost journal's
and `cross_review_state`/`cross_review_truncated` the cross-review
journal's
the same way. The report also carries the fleet controller's own recorded
lane-quality verdicts: `controller_quality_state` reports the health of
`<runs-dir>/queue/fleet-controller.json` (`'unreported'` when the caller
supplied no read — distinct from `missing`, and `invalid` when the state
document parsed but its `quality_receipts` member did not match the
recorded contract), and `controller_quality` lists the newest validated
`route.quality.v1` receipt per lane — the weight adjustment, post-merge
quality score, resolved-merge count, CI-adverse delta, closed-vocabulary
reason and controller mode (`enforce`/`shadow`) the dispatcher last
recorded for each lane, with unrecognized fields joining as `null` and
rejected rows counted in `controller_quality_invalid_rows`. These are the
verdicts the controller is actively enforcing for live routing, surfaced
here as advisory context only — the weight math still moves on
held-merge rate alone and nothing in the report applies them. Each proposal also carries an `evidence` block folded
from the same known cohort: the group's CI first-pass rate, summed review
findings, mean `cost_usd`, mean recorded `acus` (the Devin lane's billed
spend — a different unit, never mixed with USD), mean recorded
`pool_pct_used` (the reward-signal ledger's subscription-pool
percentage points consumed — the only per-job subscription-quota cost
figure, a third unit never mixed with either), the launch-cost probe
evidence — `launch_cost_known` counts the known-cohort outcomes
carrying a recorded `launch_cost_status`, `launch_cost_measured`
counts the `measured` rows inside that cohort (full-window coverage,
not `partial`), and `launch_peak_processes_mean`,
`launch_cpu_pct_mean`/`launch_cpu_pct_peak_mean` report the mean
recorded first-minute peak process count and mean/peak CPU (percent
of one core) — a fourth unit never mixed with the cost figures —
mean `wall_s`, mean
recorded `ttm_s` (merge latency), mean recorded `queue_wait_s` (the
job's queue-admission wait from its arrival stamp to first dispatch —
the same boundaries job-latency's queue_wait phase pairs), mean
recorded `ci_wall_s` (the job's CI wall seconds from its single
recorded `ci_start`/`ci_complete` boundary pair. The reward feed reads
the same boundary events within the rewarded dispatch's window. A missing,
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
advisory `passk`, the recorded repo mix — `repos_known` counts the
known-cohort outcomes carrying a recorded `repo` and `repos` breaks
the count down by repo label (most jobs first), so a group's merge
rate built wholly on one repo reads differently than one spread
across the fleet — and the dispatch lane-override tally —
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
`usage_missing` lists the top recorded capture-gap reasons,
`usage_sources` the top recorded measurement paths and `repos` the
top recorded repo labels — all across every folded outcome, known,
unknown and unclassified alike, since capture completeness and repo
identity are not merge evidence — so an operator sees where usage
telemetry is actually broken and which repos the retained window's
outcomes came from rather than only that token coverage is thin. Each proposal's evidence block also tallies the
dispatch lane-hint blocking codes — `lane_blocked_known` counts the
known-cohort outcomes whose standing claim recorded a non-empty
`lane_hint_blocked_by` (the market's recorded `[]` "nothing blocked
it" verdict does not count) and `lane_blocked_reasons` breaks the
count down by recorded code (`quota_exhausted`, `saturated`, `held`,
`lower_rank`, `hysteresis_*`), so a lane whose hinted work keeps
losing to capacity or rank shows the blocking mix behind its off-hint
share. The same evidence block also tallies the market's per-lane
rejection record — `market_rejected_known` counts the known-cohort
outcomes whose newest `route_decision` recorded a non-empty
`rejected_lanes` list and `market_rejected_reasons` breaks the count
down by recorded rejection code (each job contributes each code once
however many lanes rejected it for it), so a group whose decisions
kept bouncing off capacity or rank shows the blocking mix behind its
routing. The same evidence block also tallies the fleet's recorded
session-handoff advisories — `handoff_known` counts the
known-cohort outcomes carrying a `handoff_trigger` and
`handoff_triggers` breaks the count down by recorded trigger
(`rate-limit`, `quota-exhausted`), so a lane whose merges rest partly
on provider-wall-hit runs shows the recorded mix. The same evidence
block also tallies the fleet's recorded provider-wall lane holds —
`provider_wall_known` counts the known-cohort outcomes carrying a
`provider_wall_pattern` and `provider_wall_triggers` breaks the
count down by recorded `usage-limit`/`auth-failure` family, so a
lane whose merges rest partly on provider-walled runs shows the
recorded mix (the `autobackoff_hold` receipts — the
outcome-confirmed hold dispatchd appends — covering both the
usage/quota walls and the auth streaks the session-handoff
advisory never sees). The same evidence
block also tallies the fleet's recorded slot-throttle detections —
`pool_known` counts the known-cohort outcomes carrying a `pool_kind`
and `pool_kinds` breaks the count down by recorded class
(`credits_exhausted`, `usage_limit`, `model_capacity`, `rate_limit`),
so a lane whose outcomes rest partly on provider-throttle-hit runs
shows the recorded exposure (the `pool` receipts — the per-tick
`ratelimited()` scan's scan-time detection, covering runs the
outcome-confirmed hold never sees). The same evidence
block also tallies the node runner's recorded execution verdicts —
`node_outcomes_known` counts the known-cohort outcomes carrying a
`node_outcome` and `node_verdicts` breaks the count down by recorded
verdict word (`succeeded`/`fenced`/`failed` — the
`phm-node-runner.v1` finish rows; a verdict here means the job
reached its merge verdict through another path after a node attempt,
so the tally shows how much of the group's held-merge evidence
survived node-pool execution). The same evidence
block also tallies the merge queue's recorded per-PR history —
`merge_queue_known` counts the known-cohort outcomes whose standing PR
carried merge-events observations and `merge_queue_blocked_known`/
`merge_queue_blocked_reasons` break down those whose queue blocked the
PR at least once by recorded blocker code (`required_checks`,
`review`, `conflict`, `queue`, `other` — each job contributes each
reason once, most jobs first), while `merge_queue_check_failures_known`,
`merge_queue_conflicts_known`, `merge_queue_retries_known` and
`merge_queue_recuts_known` count the same cohort's outcomes whose PR
recorded at least one failed check observation, merge conflict,
merge-retry request or recut request — post-publish queue-side
friction behind a lane's merge latency. The same evidence
block also tallies the review gate's recorded cross-model verdicts —
`cross_review_known` counts the known-cohort outcomes whose standing
PR carried a joined `cross_review` verdict and `cross_review` breaks
the count down by recorded outcome (`approve`/`reject`/`failed`/
`skipped` — the cross-provider review's answer for the job's pull
request, advisory context like `review_findings`: a `reject` is the
recorded reason the PR may never merge, but a review verdict is not a
merge verdict and never feeds the weight). The weight math
still moves on
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
Read-only by default; it writes nothing and changes no routing by itself.
`--record` is the opt-in write: detected `RevertOutcomeRecord`s append to
`$ASHLR_HOME/improve/revert-outcomes.jsonl` (deduplicated, fail-closed on a
corrupt ledger). Recorded detections then reach both revert-evidence
consumers under their usual unambiguous-PR-claim rule:
`revertedPrKeys` — the set that withholds knowledge notes whose every
cited PR was reverted — and `readRouterOutcomes`'s `reverted` join, so
held-merge tallies in `phm fleet router-weights` and `phm node route`
see reverts that only git history proves. The ledger resolves
newest-record-per-PR, so a later scan that finds the revert itself was
reverted clears the key; a non-intact ledger contributes nothing rather
than marking merges reverted or withholding on corrupt evidence, and
`RouterOutcomeRead.revert_ledger_state` / the weight report's
`revert_ledger_state` report its health.

## Shadow policy comparison

`phm route shadow eval --input <file|-> [--policy class-failure-avoidance] [--root <directory>] [--record] --json`
evaluates a candidate adaptation policy next to the live `decideRoute` decision
on the same request and eligible candidates. The live decision is unchanged;
`--record` appends an advisory `route.shadow.v1` record (`dispatched: false`)
to `metrics/route.shadow.jsonl` without dispatching or altering routing. The
default policy (`class-failure-avoidance`) groups prior resolved outcomes
strictly by `(repo, task_class, lane)` without crossing repo boundaries or
escalating cost/speed tier, and marks sparse cells `insufficient_support`.

`phm route shadow report [--policy <name>] [--root <directory>] --json` returns
a `route.shadow-report.v1` comparison joining recorded shadow decisions with
`metrics/jobs.jsonl` outcomes by job within the same repo. Unknown outcomes
stay `null`. Disagreements, insufficient support, per-`(repo, task_class)`
summaries and off-policy IPS/SNIPS/ESS estimates (with unsupported rows counted
separately) are reported alongside a `promotion_gate` requiring prospective
matched evidence before any live routing change. When `metrics/route.shadow.jsonl`
exists, `phm route explain --json` exposes the same report as `shadow_comparison`.
