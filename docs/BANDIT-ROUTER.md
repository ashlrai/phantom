# Bandit lane router (RQ-SELFOPT-BANDIT-ROUTER)

A contextual Thompson-sampling bandit replaces the queue's static lane
routing. The code lives in `src/core/bandit/`; the offline replay is
`phm queue bandit`. The feature flag defaults to **shadow** mode.

This change provides the bandit, its flag, the outcome-log contract, the
replay estimator and the dashboard panel. It does **not** include the queue's
recorder or the host admission hook — the queue.v1 module
(RQ-PHANTOM-DRIVER-1-QUEUE) is absent from this checkout, so the runtime seam
is an exported decision API plus documented file formats, the same pattern
as the drive supervisor's bridge contract. A missing or malformed flag file
fails closed: the bandit is not consulted and the static route stands.

## Routing decision

`selectLane(input)` (src/core/bandit/select.ts) is the admission-time call a
host queue makes per READY line:

- `context` — the line's `{sizeLines, repo, tier, pool}`; `pool` is the
  line's *declared* pool, a feature of the line, not the bandit's answer.
- `lanes` — the candidate arms `[{id, pool}]`; each lane spends against the
  named pool's credit plan. Where pools are the lanes, repeat the id
  (`{id:'devin', pool:'devin'}`).
- `staticLaneId` — the lane the static router picked.
- `credits` — `{remaining: {pool: number}, floor?}`; pools absent from
  `remaining` have *unknown* headroom and are never eligible.
- `mode`, `state`, `config`, `uniform` — flag mode, persisted posteriors,
  resolved config and the random source.

The decision reports `laneId` (the applied pick), `sampledLaneId` (the
bandit's Thompson draw — always populated in shadow mode so divergence is
measurable before promotion), `eligibleLaneIds`, a `holdReason` and a
one-sentence `reason`.

### Modes

| Mode | Effect |
| --- | --- |
| `off` | The bandit is not consulted; `laneId = staticLaneId` verbatim. |
| `shadow` (default) | The bandit draws among floor-eligible lanes and reports `sampledLaneId`, but `laneId` stays the static pick. `divergent` flags disagreements for the shadow log. |
| `enforce` | `laneId` = the bandit's draw among floor-eligible lanes. When no lane clears the floor the decision is a **hold** — the bandit never routes past the plan. |

### Credit floor

`creditFloor` (default 0) is the minimum remaining credit a pool must hold
for its lanes to be eligible. Eligibility is computed *before* sampling in
every consulted mode, so a Thompson draw can never land on an over-plan
pool; an enforce-mode decision with zero eligible lanes is a hold, not a
fallback to a pool that is out of credit.

## Context model and Thompson sampling

Each context is bucketed to a cell `(sizeBucket, repo, tier, pool)`;
`sizeEdges` (default `[150, 400, 1200, 3600]`) maps line counts to
`xs|s|m|l|xl`. The model keeps a Beta posterior per (cell × lane) over the
unit reward, at four generality levels:

- **L0** size·repo·tier·pool — the exact line shape
- **L1** size·tier·pool — repo generalized (new repos borrow strength)
- **L2** tier·pool — a cold size bucket borrows too
- **L3** global — every observation lands here

Every update writes all four levels. Selection draws one `Beta(α,β)` sample
per eligible lane from the deepest level with `minCellSamples` (default 4)
observations for that lane, falling back to the configured prior
(`Beta(1,1)`) when nothing qualifies, and routes to the argmax. The draw is
deterministic under a seeded uniform source (`mulberry32`), so replays and
shadow logs are reproducible.

State is a plain JSON document (`{v:1, cells}`); `loadBanditState`/`saveBanditState`
persist it atomically under the flag root as `router-bandit-state.json`, and
`banditStateFrom` fails closed to a fresh prior on corrupt input.
`recordOutcome` folds a settled outcome into the posteriors in every mode —
shadow trains on real traffic before it is ever promoted.

## Reward

One `phantom-router-outcome/v1` JSONL row per settled routing decision:

```json
{"schema":"phantom-router-outcome/v1","job":"RQ-EXAMPLE","at":"2026-10-20T00:00:00Z",
 "lane":"devin","pool":"devin","repo":"phantom","tier":"work","sizeLines":300,
 "mergedAt":"2026-10-20T06:00:00Z","ciGreen":true,"ciWallMs":1200000,"costUsd":2.1}
```

`lane` is the arm that actually ran the job; absent, it defaults to `pool`
(the static queue's declared lane). `credits` may snapshot per-pool remaining
credit for floor-replay.

The reward is exactly the task's formula:

```
success = mergedAt exists AND mergedAt − at ≤ 24h AND ciGreen
unit    = clip01(success − cost·min(1, costUsd/costNormUsd)
                        − wall·min(1, ciWallMs/wallNormMs))
```

Defaults: `cost=0.25`, `wall=0.25`, `costNormUsd=10`, `wallNormMs=3600000`,
`success=1`. `costUsd` is the cost attributed to the PR this job produced —
the spec's "cost per merged PR" — and a job that never merged still pays its
penalty. Absent cost or CI-wall evidence is zero penalty, never synthesized.
`unit` is clipped to [0,1] for the Beta posterior; `raw` (unclipped) is kept
for reporting.

## Offline replay

```sh
phm queue bandit --events outcomes.jsonl [--seed N] [--config router-bandit.json] [--json]
```

The estimator is **rejection sampling** (Li et al. 2011): replay the log in
order; per record the bandit — trained only on what it has kept so far —
draws among the lanes that clear the floor at that record; a draw matching
the logged lane credits the record's real reward and updates the posteriors;
a mismatch drops the record, because the log cannot say what an unchosen
lane would have earned. The report:

- `before` — the logged (static) policy's mean reward over **all** records
- `after` — the bandit's mean over kept records (its unbiased estimate)
- `staticOnKept` — the logged policy over the same kept subset (matched
  evidence; identical by construction, kept as a sanity check)
- `delta`, `keptRate`, `floorDenials`, per-lane `logged/kept/mean` breakdown
- `config` echo (floor, weights, arm set) for reproducibility; a fixed
  `--seed` makes the whole report deterministic

**Honest limits.** The estimate is only as wide as the logged support: a
context where the static router never tried a lane contributes nothing, a
low `keptRate` is a thin estimate rather than a precise one, and dropped
records are reported, never silently re-scored. This is the same honesty
bar the counterfactual-judge replay holds.

## Feature flag

File: `<flag root>/router-bandit.json` (flag root: `$ASHLR_HOME`, else
`~/.ashlr`). Environment override: `PHM_ROUTER_BANDIT_MODE=off|shadow|enforce`
takes precedence over the file; an invalid value fails closed to `off`.

```json
{"mode": "shadow", "creditFloor": 0, "minCellSamples": 4,
 "reward": {"cost": 0.25, "wall": 0.25, "costNormUsd": 10, "wallNormMs": 3600000},
 "sizeEdges": [150, 400, 1200, 3600],
 "lanes": [{"id": "devin", "pool": "devin"}, {"id": "codex-personal", "pool": "codex-personal"}],
 "seed": 1}
```

Resolution (`resolveBanditFlag`): env → file `mode` → default `shadow`. A
malformed file resolves `off` and reports the parse error; a router that
cannot read its own flag is not consulted.

## Dashboard

The dev-cycle dashboard's fifth panel (`Lane reward · bandit vs static`)
plots `phantom_router_lane_reward{policy}`: `before.meanReward` exports as
`policy="static"`, `after.meanReward` as `policy="bandit"` — the before/after
numbers the acceptance asks for. See
[docs/observability/README.md](observability/README.md) for the metric
contract and its absence-tolerant semantics.

## Validation

```sh
HOME=$(mktemp -d) npx vitest run \
  test/bandit-model.test.ts test/bandit-select.test.ts \
  test/bandit-replay.test.ts test/queue-bandit.test.ts \
  test/cycle-dashboard.test.ts
```

The committed fixture (`test/fixtures/bandit/outcomes.jsonl`, 95 synthetic
rows across two lanes, two size buckets and two repos) replays to
`before≈0.48` vs `after≈0.64` at seed 7 — the shape of a report a real
outcome log should produce. Synthetic numbers demonstrate the estimator;
they are not production evidence.
