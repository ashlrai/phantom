# Queue controller

`phm queue control` computes a bounded capacity overlay from an explicit snapshot
of an ordered engineering pipeline. It identifies the bottleneck, reallocates
available slots, chooses measured faster tiers and merge batches, and adjusts
the planner's output rate. Its decisions include bandit observations and LP
inputs for issue #938.

This command operates locally and contacts no providers. The result is a control
overlay for consumers to apply through their own admission and authority gates.
It does not launch workers, alter production configuration, skip required tests,
or merge changes. RQ-PLAN, a production bandit consumer, and the #938 LP consumer
are not implemented in this checkout; the versioned output is their integration
boundary. A successful simulation proves the modeled pipeline, not live fleet
convergence.

## Run one control step

```sh
phm queue control --input snapshot.json --dry-run --json
phm queue control --input snapshot.json --out ./queue-control --json
```

`--input` is required and must name a readable regular JSON file no larger than
1 MiB. `--out` is required except for a dry run. A dry run creates no storage,
even when an output directory is supplied. `phm queue help` describes arguments.
Unknown, repeated, incomplete, or positional extra arguments fail with exit 2.
Invalid input or a persistence failure exits 1; successful evaluation exits 0.

## Snapshot contract

Rates use jobs per second. `observedAt` is an epoch timestamp in milliseconds.
`arrivals` is the number of jobs observed during `windowSeconds`; `queued` and
`previousQueued` describe the ends of that observation window. Each stage's
completed jobs become the next stage's arrivals, with no fan-out or rework in
this version. Supply separate snapshots for pipelines with different semantics.
`plannerRate` is the requested, unthrottled demand. Keep it separate from the
returned planner rate limit so a temporary throttle does not erase the demand
that should resume after the queues drain.

```json
{
  "schema": "phantom-queue-snapshot/v1",
  "stream": "engineering",
  "observedAt": 1793016000000,
  "windowSeconds": 10,
  "plannerRate": 1,
  "targetUtilization": 0.8,
  "pools": [{ "id": "workers", "slots": 4, "available": true }],
  "stages": [{
    "id": "build", "kind": "work", "pool": "workers",
    "queued": 5, "previousQueued": 2, "arrivals": 10,
    "slots": 1, "minSlots": 1, "maxSlots": 4,
    "tier": "standard",
    "tiers": [
      { "id": "standard", "serviceRate": 1 },
      { "id": "fast", "serviceRate": 1.5 }
    ],
    "impact": false, "batchSize": 1, "batches": []
  }]
}
```

Stages have `kind` equal to `work`, `test`, or `merge`. A pool's slots are a
shared hard ceiling, not an invitation to provision more resources. Only list
already-authorized tiers and measured per-slot service rates. Merge `batches`
contain `{ "size": 2, "serviceRate": 1.5 }` alternatives with measured total
per-slot throughput; batch size alone is not evidence of linear speedup.
Unavailable pools provide no capacity.
Current `slots` may fall below `minSlots` after an outage; the minimum is a
transfer floor, not a reason to reject recovery telemetry. Positive measured
service rates must be between 0.000001 and 1000000 jobs per second; zero means
no measured service. Merge stages have one fixed tier, so unrelated tier and
batch speedups cannot be multiplied together.

Test-impact selection is advisory preflight selection. Required checks remain
mandatory, and the controller never discounts their cost to claim faster
service. Consumers must continue to enforce required checks, resource quotas,
paid-resource authorization, kill switches and merge gates independently.

## Decision and persistence

JSON output contains `{ "decision": ..., "persistence": ... }`. The decision
uses `phantom-queue-control/v1` and includes the input digest, named bottleneck,
control actions, effective allocations, and planner mode/rate/reason.
`persistence` is null for dry runs; otherwise it identifies the recorded path
and whether the identical decision was already recorded.
Each observation is stored under `DIR/STREAM/OBSERVED_AT.json` as one atomic
envelope containing the controller, bandit and LP records. An identical replay
is idempotent; a different decision for the same observation or a new observation
older than one already recorded is refused. Consumers read this shared envelope
so bandit and LP projections refer to the same decision.
Consumers must apply each decision once in observation order through existing
admission gates. Returning a historical replay does not renew its allocation.

The embedded `phantom-queue-bandit/v1` record carries context and actions with
`reward: null` and `status: "awaiting-observation"`. A chosen action is not a
measured success; a later consumer must join actual outcomes to its decision ID.
`phantom-queue-lp-inputs/v1` carries pool bounds, allocations, stage backlogs and
arrival rates, planner limits, target utilization, and
`requiredChecks: "preserved"`. These records share the controller decision ID.

Overload acceptance uses deterministic simulations with continuous arrivals,
bounded capacity, planner throttling and recovery. If available service is zero
or mandatory stage minima exceed capacity, a controller cannot promise work
will drain; such capacity constraints must be resolved by the operator or an
authorized upstream allocator.
Continuous admission assumes enough pool slots for all pipeline stages to have
positive capacity simultaneously. With fewer slots, zero-floor idle stages can
yield capacity to drain finite downstream work, but planning remains held until
the pipeline has simultaneous capacity. Time-sharing admission is outside this
version's model.
