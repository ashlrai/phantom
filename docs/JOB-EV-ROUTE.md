# Job EV routing

`phm route job` chooses one queue job's budget pool, routing tier and serving
model by expected merged impact per token. The command reads a job spec, an
optional metrics feed and an optional budget pressure document, then prints a
`JobRouteDecision` JSON object. It is advisory only: it never dispatches work,
moves a balance, touches a provider or writes state, and it never echoes task
text back into the output.

```
phm route job --input <job.json|-> [--metrics <feed.json|->] [--plan <plan.json|->] [--budgets <snapshot.json|->] [--json]
```

`--input` is required and accepts `-` for standard input; at most one option
may read stdin. `--metrics` and `--plan`/`--budgets` may be local files or
stdin. With neither pressure option the command reads the local budget ledger
the same way `phm budget show` does. Output is always JSON; exit 0 means a
decision was reached, including a hold. Exit 2 means invalid arguments or
input; errors are controlled diagnostics that do not repeat input contents.

## Job input

```json
{ "id": "RQ-EXAMPLE", "repo": "ashlrai/phantom", "task": "rebase and format",
  "template": "mechanical", "riskTier": 2, "difficulty": "low",
  "expectedImpact": 5 }
```

Only `id` is required. `template` takes the aliases in
`src/core/fleet/job-ev-route.ts` (`rebase`, `docs`, `format`, `feature`,
`security`, `tier-1`, ...). `riskTier: 1`, `difficulty: "high"`, an expected
impact at or above 40, or hard keywords in `task` all force the hard template;
mechanical keywords classify mechanical work; everything else is standard.
Unknown fields are ignored and the task text is never retained or printed.

## Decision output

```json
{ "schemaVersion": 1, "kind": "job-route", "job": "RQ-EXAMPLE",
  "repo": "ashlrai/phantom", "template": "mechanical", "action": "route",
  "pool": "local-omlx", "tier": "local", "model": "omlx/27b",
  "expectedImpactPerToken": 0.001, "priorBasis": "laneTier local-omlx/local",
  "expectedTokensPerMergedPR": 120000, "reasons": ["..."], "excluded": [...] }
```

`action` is `route` or `hold`. A hold is a decision, not an error: it means no
admitted arm exists and the job should wait rather than spend outside its
guards. `excluded` lists every arm that did not win with its reason, including
tier-guard and budget-pressure exclusions.

## Guards before the EV ranking

1. Mechanical jobs route to `local-omlx` only. They are never upgraded to paid
   spend silently; when local capacity cannot admit them the answer is a hold.
2. Hard or high-impact jobs route to frontier arms only (`codex-cmp`,
   `codex-personal`, `claude`, `devin`, `grok-ultra`); local and mid arms are
   excluded outright.
3. Budget pressure excludes an arm while its pool is over pace, paused, held
   or closed. Unknown pressure is neutral and still admits, so a missing
   reading never masquerades as zero.

## Priors and the objective

The objective is expected merged impact per token, not merges per token:
failed and empty jobs already sit in the token denominator, so a lane that
merges often but burns budget on empty work loses to one that lands impact.

`--metrics` accepts the router metrics feed shape or the same keyed maps:

```json
{ "lanes": { "devin": { "mergedImpactPerToken": 0.02, "completedJobs": 9 } },
  "tiers": { "mid": { "mergeRate": 0.5, "tokensPerMergedPR": 100000, "completedJobs": 5 } },
  "laneTiers": { "devin/frontier": { "mergedImpactPerToken": 0.05, "completedJobs": 4 } },
  "templates": { "standard": { "mergedImpactPerToken": 0.03, "completedJobs": 20 } },
  "overall": { "mergedImpactPerToken": 0.01, "completedJobs": 40 } }
```

Each arm looks up `laneTier`, `template`, `tier`, `lane` then `overall`, and
the first group with at least `MIN_PRIOR_JOBS` (3) completed jobs supplies its
prior. A measured `mergedImpactPerToken` is used verbatim; the
`phm metrics` rollup name `valuePerMTok` is accepted and converted. When only
merge and token measurements exist the EV is derived as the job's expected
impact divided by `tokensPerMergedPR`. When no group qualifies, cold-start
ordering values rank the arms; once any arm carries a measured EV, arms with
no evidence score zero rather than outranking real data on a guess. Ties
resolve to fewer expected tokens per merged PR, then cheapest-first arm order.

## Budget pressure

`--plan` accepts a `phm budget plan` document (`fleet.budget-plan.v1`), wrapped
or bare. The plan's `concurrency` and `lane` fields map to pressure: `pause`
is paused, `held` is held, an empty `lane` or `maxConcurrency: 0` is closed,
and `lower` or a `paceRatio` beyond the plan's tolerance is over pace.
`--budgets` accepts a `phm budget show` snapshot (`fleet.budgets.v1`) as the
degraded fallback: exhausted and reset-pending lanes are paused, held pools
are held, zero observed capacity is paused, a lane the ledger already
projects dry is over pace, and unobserved lanes stay unknown. A plain burn
projection is not enough to call a pool over pace from a snapshot; the plan
carries the pace target.

## Position in the fleet

This command is the per-job routing answer inside the expected-value path: the
queue's trusted router supplies the job spec and consumes the decision, while
`phm metrics` supplies the priors and `phm budget` supplies the pressure.
Dispatch authority stays with dispatchd; this module only ranks.
