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
