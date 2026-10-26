# Coding-pool scheduler

The drain tick assigns queued jobs to coding pools. It solves a mixed-integer
linear program with [HiGHS](https://highs.dev/) (`highs` on npm, the highs-js
WebAssembly build) and falls back to the existing greedy spend order when that
solve fails or exceeds its budget. The tick does not spawn a CLI, open a pull
request, or merge. Merge authority stays on the existing gate.

Box agents enqueue heavy work (coding, long investigations, test fixing,
research). The orchestrator keeps orchestration, review, and merge decisions.
Jev remains the complexity and risk classifier (`classifyJob`). A `kind:` label
on an issue selects the job type; otherwise a keyword fallback does.

## Pools

| Pool | What it is | Host | Objective rank |
| --- | --- | --- | --- |
| `codex-primary` | Codex work account. Spend first. | Mac | first |
| `codex-secondary` | Second Codex login | Mac | next |
| `claude` | Claude Code Max, `claude -p`. Live as of the Oct 25 reading. Quota unknown until a reading arrives. | Mac | next |
| `devin` | Devin v3 ACUs. Off unless the existing `cog_` key gate passes. | remote | next |
| `grok-build` | Grok Build. Still behind the metered opt-in, because the catalog classifies `grok` as `XAI_API_KEY` billing. | Mac | next |
| `local` | oMLX on loopback | Mac | next |
| `grok-ultra-weekly` | One Grok Ultra weekly limit shared by Grok Bot and Cursor | remote | cloud agents last among these, at a high shadow price |
| `metered` | Metered APIs. Off until `--enable-metered`. | remote | last |

`cursor-cloud` and `grokbot` are not pools. Both are consumers of
`grok-ultra-weekly`: `orchestrator` and `cloud-agent`. Sub-usage is tracked on
those two consumers. Cloud-agent jobs are ordinary produce work. Orchestrator
jobs are orchestration, review, and merge *decisions*. An assignment never
sets merge authority.

Defaults live in `config/router-scheduler.json`, labelled
`Mason, Oct 25 2026 11:26 PM ET`. Callers override any numeric field. The
posting flag cannot be turned on.

## Grok Ultra estimate

The weekly quota and its reset are not readable from an API. The scheduler
models them from the config snapshot plus per-run usage events, and labels the
result an estimate.

- Snapshot: 36% used at 2026-10-25 23:26 America/New_York (`2026-10-26T03:26:00.000Z`).
- Next reset: 2026-11-01 20:21 America/New_York (`2026-11-02T01:21:00.000Z`), then every 7 days.
- No extra-usage credits. Spend cannot exceed the remaining fraction.
- The 36% snapshot is not split by consumer. Events after the snapshot add to `orchestrator` or `cloud-agent`. After a reset, the snapshot is dropped and only events inside the new window count.

## Objective

For each job \(j\) and eligible pool or consumer \(p\),

\[
c_{jp} = v_{jp} - \text{monetaryCost}_p - \text{preferencePenalty}_p - \text{shadow}_p + \text{roleFit}_{jp} + \text{loseIt}_p
\]

\(v_{jp}\) is the posterior expected value: Beta success mean times quality,
minus a latency penalty and a token penalty. The canary (default 10%, a stable
hash of the job id) either Thompson-samples that posterior or, when a candidate
policy is present, scores the candidate. Every other job uses the incumbent
mean. A seed makes the sample deterministic.

The shadow price applies only to `grok-ultra-weekly` cloud agents (default
0.75). Pools with \(c_{jp} \le 0\) are left out of the program, so a scarce
pool is not spent on a negative-value job. The solver maximises
\(\sum c_{jp} x_{jp}\).

Use-it-or-lose-it: a pool with an expiry before its reset, or a reset that
does not carry credit, gets

\[
\text{loseIt} = \text{loseItWeight} \times \mathrm{clamp}\left(1 - \frac{\text{time left}}{\text{window}}, 0, 1\right)
\]

`window` is the pool's reset period, or seven days when an expiry has no reset period. Unknown deadlines add no bonus.

## Constraints

\(x_{jp}\) is binary. Each job is assigned to at most one pair. A job marked
`requireAssignment` must be assigned; if it has no eligible pair the model is
infeasible and the greedy fallback is not used.

- Quota. A known balance caps total demand. An unknown balance uses the
  conservative daily soft cap (`UNKNOWN_BALANCE_SOFT_CAP_PER_DAY`, one unit,
  unless overridden). Local oMLX is unlimited apart from concurrency and the
  host floors.
- Concurrency. Each pool has a cap (default 1), minus in-flight work. The two
  Grok Ultra consumers share one cap.
- Mac disk floor 20 GB and battery floor 30%. A numeric reading below the
  floor removes Mac pools (`codex-primary`, `codex-secondary`, `claude`,
  `grok-build`, `local`). A null reading does not invent a violation. Remote
  pools stay eligible.
- Credit expiry. A known expiry at or before now removes the pool.
- Tier floor. A pool below the job's minimum tier is ineligible. Merge
  decisions are frontier. Local, subscription, loopback, and metered backends
  never receive a merge or credential role (`roleAllowed` is unchanged).
  Credential jobs stay unassigned.
- Grok Ultra pacing is a receding horizon to that pool's own reset, not a
  fresh slice of whatever remains. The ideal line runs from 0 at the window
  start to 1 at reset. This tick may spend only its first period, and only
  while used quota sits under that line plus a small flex. Quota already
  ahead of the line waits. Unused allowance stays in the remainder and the
  next cycle replans it, so a skipped period is carried forward. A safety
  buffer (default 2% of the quota) and the orchestration reserve (default
  15% of the quota, cloud agents only) shrink linearly to 0 over the last
  12 hours (`horizon.bufferWindowMs`). The plan itself still lands on 100%
  at the reset. There is no overage variable unless `extraUsageCredits` is
  explicitly overridden. Varying period values are a small HiGHS LP with the
  same time budget and the even plan as fallback. Flat values use that even
  plan directly.

## Solver

HiGHS is loaded once. The 100 ms budget (`solverBudgetMs`) is the native
`time_limit` and a wall-clock backstop around the solve call, not around the
WebAssembly startup. Status `Optimal` is kept. Status `Infeasible` is kept and
not repaired. `Time limit reached`, any other status, or a throw uses
`rankSpendPools` from `src/core/resources/pool-spend.ts`: soonest credit
expiry, then unknown credit, then subscriptions, then local, then metered.
Negative-value pairs are still skipped on that path, and the quota,
concurrency, host, role, and pacing constraints still apply. The order among
the pairs that remain is the existing greedy order, which is why a
higher-headroom subscription can beat `codex-primary` only on the fallback.

## Learning

Arms are keyed by job type, pool, and Grok Ultra consumer. A merged green run
that was not reverted increments the Beta success count and a quality
observation \(1 / (1 + \text{review rounds})\). Anything else increments the
failure count and records quality 0. Wall time and tokens update Normal
means. Replay over the decision log is inverse propensity scoring and doubly
robust estimation. A candidate policy is promoted only when its doubly robust
score is strictly higher and the row count meets `promotionMinRows` (default
20). Every drain decision can be appended to the decision log. The logged
propensity is 1 because the seed makes the draw deterministic.

## Regret

`phm router regret` folds the outcome ledger into the posterior, writes jobs
where another pool's mean is higher to a local JSON backlog, and sets
`postIssues` to false. `--post` and `--post-issues` print that posting is off.
They do not create GitHub issues or comments.

## Telemetry

The sink is a no-op unless `posthog.enabled` is true and both `host` and
`apiKey` are set. Events:

- `phantom_pool_burndown` — remaining fraction, reset, estimate label, sub-usage, derived landing and uncertainty. `is_reading` is false.
- `phantom_grok_ultra_runway` — hours to reset and paced runway
- `phantom_pool_value_per_dollar` — net value over monetary cost, or null when the pool has no dollar cost

Manual readings live in a fleet file (`PHANTOM_FLEET_FILE`, for example `/workspace/phantom-work/fleet.json`) under `readings`: `{ poolId, value, timestamp, source: "manual" }`. The value is a used fraction. A projection built from it carries that timestamp's age and a stale flag. It is not a live reading.

`docs/router/posthog-coding-pools.json` is the dashboard definition. In
PostHog, create a dashboard and add the three trends queries, or use the file
as the insight spec.

## Tuning

Edit `config/router-scheduler.json` or pass overrides into `schedule` /
`loadSchedulerConfig`. The fields that move decisions are `preferencePenalty`,
`cloudShadowPrice`, `orchestrationReserveFraction`, `paceTickMs`,
`horizon.bufferFraction`, `horizon.bufferWindowMs`, `horizon.flex`,
`loseItWeight`, `canaryPercent`, `solverBudgetMs`, `diskFloorGb`, and
`batteryFloorPercent`. Lower the shadow price only when cloud-agent jobs are
waiting behind a full Mac and the posterior says they are worth the weekly
limit. Raise the reserve when orchestrator runway is the thing you are
protecting.
