# Fleet outcome metrics v1

RQ-GROK-SELFMETRICS-1. Offline measurement and advisory policy, independent of
[the existing fleet IQ report](../FLEET-VERBS.md). No dependencies, network,
model calls, writes, routing changes or sending. The CLI only reads a ledger.

## Interface and commands

`src/core/fleet/outcome-metrics.ts` exports `buildOutcomeMetrics(input)`:
`{ events: readonly unknown[] | null, nowMs: number, hours?: number,
sourceState?: 'healthy' | 'degraded' }` to `OutcomeMetrics`
(`fleet.outcome-metrics.v1`). Clock and event stream are injected. Windows
are inclusive, trailing 1–2160 hours; default 24. Invalid windows throw.

```sh
phm fleet metrics report --hours 24 --json
phm fleet metrics suggest --json
phm fleet metrics weekly
phm fleet metrics weekly --jobs fixture.jsonl --json
```

`src/cli/fleet-metrics.ts` exports `cmdFleetMetrics(args, deps?)`, with injected
`read(path): Promise<string | null>` and `now(): number`. Default source:
`~/.ashlr-runs/metrics/jobs.jsonl`. Reads refuse non-files and files over
16 MiB; no partial-tail extrapolation. JSONL invalid rows mark evidence degraded.
Exit 0 healthy, 1 missing/degraded, 2 usage. Flags are strictly parsed; no apply
verb. Weekly defaults to 168 hours; `--hours` can override it. JSON weekly output
contains `metrics`, `suggestions`, `markdown`; report emits metrics, suggest
emits policy. Plain output is Markdown. Nothing schedules or sends a brief.

## Cohorts and unknowns

- Launch cohort: attempts launched within the window. Events are sorted by
  event time; each new launch for a job starts a new attempt. Launch metadata
  owns lane/model/tier attribution. Exact duplicate rows are idempotent. Conflicting launch metadata at one
  timestamp degrades the source and leaves route attribution unknown.
  Finishes/publications join the preceding launch; orphan rows never invent
  launches. Future events are excluded. Job IDs must not represent concurrent
  attempts; delayed events must retain their original event timestamps.
- `byLane` and `byModelTier` contain `{jobs, finished, finishRate, prRate,
  emptyRate, medianDuration, estCost, samples, evidenceRefs}`. Model-tier names
  are JSON tuples; absent metadata stays null (lane bucket `unknown`).
  `finishRate` is observed finishes / launched attempts. PR rate is published
  attempts / attempts with explicit PR evidence (valid GitHub publication URL,
  `hasPr` boolean, or `empty: true`). Nonempty alone does not prove a PR.
  Empty rate uses only finishes with an explicit `empty` boolean.
- Durations are seconds: `wall_s`, otherwise finish minus launch. Multiple
  conflicting finish rows retain finish presence but contribute no duration,
  cost or empty measurement. `estCost` sums recorded nonnegative finite USD
  `estCost`, `cost_usd` or `cost` only with full launch-cohort cost coverage.
  Token counts never imply pricing. Explicit cost zero is a measurement.
- `samples` exposes PR denominator, published attempts and empty/duration/cost
  coverage. Rates with no denominator and missing durations/cost are null;
  unavailable source has null totals and no invented groups. A healthy empty
  stream measures zero launches, with null rates. Degraded metrics describe
  only evidence retained and must not be interpreted as complete population data.
- Merge cohort: unique GitHub PR URLs with a known merge time in the window,
  regardless of launch time. `outcome` MERGED (including raw
  `metrics-outcomes-reconciler` rows) requires `mergedAt`; `merged` may use
  its event timestamp. Missing/conflicting times increment `unknownMergeTimes`.
  Repeated observations cannot inflate merges. `mergesPerDay = merged*24/hours`.
  Time-to-merge is explicit `ttm_s`, else merge minus earliest observed
  publication. Conflicting `ttm_s` stays unknown. Percentiles p50/p90/p95 use
  linear interpolation over measured seconds and report sample count.
- Seven-day reverts require an explicit `revert` event on the original PR URL
  or a `revertedAt` timestamp within seven days after merge. No title heuristic.
  A negative observation requires `revert_coverage` with full `owner/repo`, ISO
  `from` and `through` spanning merge through merge+7d; `through` cannot exceed
  the coverage event timestamp. This is an injected evidence assertion: a caller
  must supply it only after a complete observation. Existing writers do not
  supply it automatically. The repo rate stays null unless every merge is
  covered or explicitly reverted; `revertSamples` and `reverted` disclose the
  observed subset. A recent merge without a revert remains unknown.
- `events:N` refs point to the zero-based injected array index (CLI: nonblank
  JSONL rows including malformed rows). Coverage refs accompany repo metrics.

## Suggestions and weekly brief

`src/core/fleet/policy-suggest.ts` exports `suggestOutcomePolicy(metrics)`:
`PolicySuggestion` (`fleet.policy-suggestion.v1`) with `suggestOnly: true`,
source/window, `laneTargetDeltas`, `tierRoutingHints`, `promptTemplateFlags`.
Each entry includes reason, confidence and evidence refs. Missing/degraded
sources abstain. Each list caps at eight; lane deltas are exactly -1 or +1.

At least 20 attempts are required. At least 20 explicit empty observations and
empty rate >=50% flag scope/context review and suggest one fewer slot. An
increase requires all attempts finished, full cost/PR/empty coverage, PR rate
>=80% and empty rate <=10%; capacity and budget still require checking. Within
one tier, prefer a model only with complete cost/PR coverage and completion,
>=80% PR rates, >=20% lower USD per published attempt and no more than five
percentage points lower PR rate. These observational hints do not establish
causation, task-mix equivalence, durable merge quality or available capacity.
No exact prompt template is blamed without template evidence; flags scope a
lane for review. Confidence is heuristic evidence strength `min(.9,n/(n+20))`,
not a calibrated probability. No consumer applies this report automatically.

`src/core/fleet/weekly-self-report.ts` exports
`generateWeeklySelfReport(input: Omit<OutcomeMetricsInput, 'hours'>): string`,
which always uses 168 hours, plus `renderOutcomeReport(metrics, suggestions)`.
Markdown is ready for chief-of-staff attachment and includes coverage, sample
counts, lane/model-tier rates, repo merges/reverts, merge-time percentiles and
advisory reasons/evidence (first five refs per suggestion; full refs in JSON).
It has no storage or transport side effects.

Hermetic regression coverage: `test/fleet-outcome-metrics.test.ts`.
