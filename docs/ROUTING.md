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

The request has exactly `task_class`, `repo`, `tier_hint`, `lane_candidates`,
`quota_state` and `machine_state`. Task classes use the existing
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

## Adequacy, cost and latency priors

The directive's table is encoded as ordinal preferences, with no invented
dollar prices or measured latency. The checked-in
[router benchmark](../benchmarks/router-eval/baseline.md) measures historical
lanes; it does not establish comparative Sol/Sonnet/Astra/Fable model latency.

| Models | Speed tier | Cost / latency preference |
| --- | --- | --- |
| Sol, Sonnet | everyday | 1 / 1 |
| Opus, Sol at work tier | workhorse | 2 / 2 |
| Astra, Fable | premium | 3 / 3 |
| Other configured models | tier hint | unknown, sorted after known priors |

`frontier` requires premium, `work` requires workhorse or premium, and
`mid`/`fast` accept everyday or above. Fallback sorts by the least adequate
tier, cost rank, latency rank, then lane ID. No low-effort route is invented;
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

Reports contain `lane`, `model`, `effort`, `speed_tier`, fixed `reason_codes`,
`path`, `duration_ms`, `attempts`, `candidate_count`, `schema` and `advisory`.
With no eligible candidates the four route fields are all `null`; there is no
synthetic runnable lane. No candidates or one candidate means zero model calls.

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
`phm route explain --json` keeps its existing hysteresis report contract.
