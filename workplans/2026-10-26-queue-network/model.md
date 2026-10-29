# Fleet queueing-network model (`qnet.v1`)

Design for modelling Phantom's autonomous fleet as an open queueing network, so
arrival pressure, service capacity, blocking and rework can be measured,
estimated and advised on instead of tuned by feel. This document is the design
contract for the child jobs in [children.json](children.json). Nothing here is
implemented yet; every child is a proposed job, not a dispatched one.

## Why a queueing network

The fleet already behaves like one. Work items arrive from scanners, goals,
generated repairs and escalations; they wait in the backlog; they are dispatched
to one of a small set of lanes (local runtime, Grok CLI, Claude CLI, Codex,
Devin CLI), each with a bounded number of slots; completions produce proposals
that queue for verification, serial merge gates and owner review; failures
feed back as repairs or quarantine holds. Today each brake and gate is
implemented locally (`backpressure.ts`, `dispatch-router.ts`, `scheduling.ts`,
`headroom.ts`), but there is no single model that answers: where is the
bottleneck, what is the arrival-to-landed cycle time, what is one more slot
worth, and which queue is about to saturate when a usage window closes.

The model below names those pieces once, in `qnet.v1`, and defines the
estimation and advisory-control contract the child jobs build.

## Entities

### Job classes

A job is a `WorkItem` reduced to a **class**:

```text
class = (sourceKind, tierRequirement, effortBand)
```

- `sourceKind` — the item source (`issue`, `goal`, `security`, `feature`,
  `invent`, `repair`, `escalation`, ...). Repairs and escalations are
  first-class because they are the network's feedback edges.
- `tierRequirement` — `frontier` / `mid` / `local-capable` / `local-only`,
  derived by the same rules the dispatch router applies today
  (`isFrontierItem`, `isSubstantiveItem`, local-only policy); it bounds which
  lanes may serve the class at all.
- `effortBand` — `small | medium | large` from `item.effort`/`score`, since
  `effort >= 4` flips routing; bands keep per-class service estimates honest
  instead of pooling 5-minute repairs with day-long features.

Classes are the network's customer types: every rate and probability below is
estimated per class where identifiability allows, and explicitly pooled where
it does not.

### Nodes

Each node is `{ id, kind, servers, capacity, discipline }` in Kendall-ish
notation `A/S/c/K`, extended with a **vacation process** for windowed capacity:

| Node | Kind | Servers `c` | Notes |
| --- | --- | --- | --- |
| `backlog` | infinite buffer | ∞ | Arrival point. FCFS with priority; admission is a property of selection, not storage. |
| `lane:<laneId>` | G/G/c + vacations | `LANE_DEFAULT_SLOTS` narrowed by readiness, grant scope, rollout stage, presence caps | One node per fleet lane (`local`, `grok-cli`, `claude-cli`, `codex`, `devin-cli`). Vacations: a lane's service rate drops to 0 while its account window is exhausted, until `resetsAt`/`nextEligibleAt`; local c drops to `PRESENCE_LOCAL_SLOTS` while Mason is present. |
| `hold:park` | delay node | ∞ | Deterministic delay until a seat's `nextEligibleAt`; work is parked, not dropped. |
| `hold:cooldown` / `hold:demote` | delay node | ∞ | Deterministic 6-hour delays from `BACKPRESSURE_LIMITS`; repo-level and route-level respectively. |
| `hold:split` | absorbing fail state | — | Items that fit no seat's context; never dispatched, explicitly never diverted to a smaller model. |
| `verify` | G/G/c | bounded by the verifier budget (2 machine-wide, 1 per repo) | Proposals waiting for verification; backpressure brake 2 measures this queue. |
| `gate:G1b`..`gate:G7` | serial stations | 1 each | The merge-gate sequence; each refuses with its own probability and sends rejects to `rejected`. G0/G1 refuse for authority reasons and are modelled on the *entry* edge, not as work-quality rejects. |
| `review` | G/G/1, presence-bounded | 1 | Owner attention: merges that need a human decision. Service process is daily and bursty; the model treats it as a vacation server with observed open/close periods. |
| sinks `landed`, `rejected`, `reverted`, `dropped`, `quarantined` | absorbing | — | Terminal states; `reverted` is observed post-merge and credited back to the producing route. |

### Routing matrix

Open network: external arrivals enter `backlog`; departures leave at the sinks.
Interior edges with probabilities estimated from the ledgers:

- `backlog → lane:<id>` — assignment probability per class and lane (this is
  the controllable edge; today it is `routeSeat` + `routeBackend`).
- `lane:<id> → verify` — probability a dispatch produces a proposal at all
  (vs. `dropped:empty`, `dropped:error`).
- `verify → gate:G1b → … → gate:G7 → landed` — serial; each gate has
  pass/refuse probability per route and class.
- `lane:<id> | gate:* → rejected → hold:cooldown | hold:demote → backlog` —
  the rework feedback edge: counted failures trigger 6-hour delays, then the
  item (or a generated repair child) re-enters the backlog.
- `landed → reverted` — post-merge observation edge; revert counts against the
  producing route and raises the feedback flow.
- any node → `hold:*` edges driven by the vacation/hold processes above.

## Parameters the estimator must produce

All rates are per `(class, lane)` cohort where the cohort has enough samples;
explicitly `null`/pooled otherwise — unknown is never rendered as zero or
invented.

- `λ_k` — external arrival rate per class (items/hour into `backlog`).
- `μ_{k,i}` — service rate per lane and class (1/median service duration),
  from `WorkHistorySample`-style completed observations; tokens optionally
  tracked as a second service dimension.
- `p_{ij}` — routing-matrix probabilities per route (engine × repo × kind is
  the existing `routeKey`; the network aggregates it to `(class, lane)`).
- `a_i(t)` — lane availability in `[0,1]`: the capacity-window schedule from
  seat headroom (`usedPercent`, `resetsAt`, reserves). `a_i = 0` while a
  binding window is spent; partial while reserves or presence caps bind.
- `b_j` — blocking state per brake (open-PR cap, verify-wait cap, cooldown,
  demote): engaged or not, with the observed engagement frequency.

## What the model computes

Given estimated parameters and the projected state:

- **Offered load / utilization** `ρ_i = λ_i / (c_i · μ_i · ā_i)` per lane;
  the network is stable only where `ρ < 1` at every interior node.
- **Queueing metrics** per node: expected number `N_i`, mean wait `Wq_i`,
  mean cycle time `W_i`; end-to-end `W` from `backlog` arrival to `landed`.
  Service is general (percentile-observed, not exponential), so the engine
  uses an Allen–Cunneen-style GI/G/c approximation with the observed
  coefficient of variation; delay nodes contribute their residual delay.
- **Throughput** `X_i` per lane and class; `X_landed` and the rework
  amplification factor `1/(1 − p_rework)` so a rising revert/reject rate
  shows up as extra load, not just a quality metric.
- **Cost coupling**: `USD/landed` and `landed/hour` per lane join the flow
  model with budget headroom, so "cheap lane" and "fast lane" are one
  quantity in control decisions.
- **Consistency check**: Little's-law residual `|N_i − λ_i W_i|` per node as a
  self-health metric; a sustained residual flags that the event stream, not
  the fleet, is what is broken.

## Emitters

One bounded, append-only, schema-versioned event stream
(`queue:event`, `qnet.v1`), written at the network's edges:

`arrive` (backlog intake), `enqueue`/`dispatch` (lane), `hold`/`release`
(park, cooldown, demote, split, budget hold), `depart` (lane completion),
`verify` enter/leave, `gate` enter/verdict, `land`, `reject`, `revert`,
`expire`.

Each record carries only: schema id, event kind, timestamp, item id + class,
node id, lane/seat *category* (never account identity beyond the existing
hashed `accountHint`), queue depth after the event, and a bounded correlation
id. **No** prompt text, diffs, paths, argv, stdout, stderr, environment or
secret material — the same metadata-only discipline as
`dispatch-production-ledger` and `agent-action-ledger`. Source reads are
fail-soft with `sourceState` (`healthy | degraded | unavailable`), matching
existing readers.

## Estimator

Pure functions over the event stream and existing history readers:

- Windowed EWMA for `λ` and `p`; windowed percentiles for service `1/μ` —
  the same percentile machinery as `work-estimates.ts`, generalized to nodes.
- **Identifiability labels** per estimate: `identified` (≥ min samples in
  cohort), `pooled` (fell back to class-level), `insufficient` (reported
  `null`; downstream nodes render unknown, never zero).
- Vacation schedule `a_i(t)` projected from headroom windows; where a window
  is unreadable the lane's availability is `unknown`, not `1` — the existing
  "no signal is not headroom" rule applied to the model.

## Controller (advisory)

A pure function `(snapshot, estimates, policy) → recommendations[]` evaluated
per daemon tick:

- `admit | hold` per class: stop class intake early when a *downstream* node
  (verify, gates, review) is the binding constraint — the model answers what
  backpressure's fixed constants cannot see.
- Per-lane slot recommendations: suggested `c_i` under current `a_i(t)` and
  ρ, with reasons.
- Reroute suggestions when a lane is in vacation or demotion and another
  lane's `ρ` and cost-per-landed dominate.

**Hard boundary:** the controller recommends; it never dispatches, mutates
the backlog, moves budgets or touches authority. Precedence is fixed:
kill-switch/holds > backpressure brakes > budget policy > qnet advice.
Flag-gated (`foundry.qnet.*`, default off); flag-off restores byte-identical
legacy behaviour. Every recommendation carries its reasons and inputs so a
human can audit the advice without replaying the model.

## LP / bandit feed

A per-epoch, metadata-only export for an external optimizer:

- **Reward vector** per `(route, class)`: `landedPerHour`, `usdPerLanded`,
  `pSuccess` (verify+gate pass), `reworkRate`, plus identifiability tag.
- **Constraint matrix** rows: slot bounds `0 ≤ x_i ≤ c_i·a_i`, window
  reserves, per-repo open-PR cap, verify capacity, budget caps — the LP is
  `max Σ r·x` subject to those rows; a small deterministic in-repo solver
  covers the test fixture sizes so the harness needs no new dependency.
- **Bandit context** = (class, current `a_i`, `ρ_i`, brake state); reward =
  realized landed-per-attempt with cost normalization. The feed is *input to*
  an optimizer; promotion of any learned weight into live routing stays
  human-gated, matching the standing rule that advisory overlays never
  auto-apply.

## Desktop graph

A console view (the desktop app embeds the same build) rendering the live
network: one node per queue with WIP badge and utilization ring, edges whose
thickness follows measured flow `λ_i p_ij`, vacationing lanes shown as
suspended with their `resetsAt`, brakes rendered as engaged/idle. Data comes
from a read-only projection endpoint; every panel distinguishes
healthy/degraded/unavailable sources and never fabricates a quiet queue.

## Honesty and safety invariants

1. `null` = unknown. No fabricated rates, depths, or availability.
2. Metadata only. Queue telemetry is an allowlist; payloads stay out.
3. Advisory only. The model never mutates routing, dispatch, budgets or
   authority. Flag-off = legacy behaviour.
4. Fail closed. Unreadable ledgers, hostile timestamps, malformed events:
   mark `degraded`, withhold affected estimates, keep the rest honest.
5. The network describes the fleet; it is not the fleet. Blocking brakes and
   authority gates keep precedence over any recommendation.
