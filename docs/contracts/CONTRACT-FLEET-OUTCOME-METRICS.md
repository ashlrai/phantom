# Fleet outcome metrics v1

RQ-GROK-SELFMETRICS-1. Offline measurement and advisory policy, independent of
[the existing fleet IQ report](../FLEET-VERBS.md). No dependencies, network,
model calls, writes, routing changes or sending. The CLI only reads a ledger.

## Interface and commands

`phm fleet metrics --json` (or `metrics series --json`) returns
`fleet.metrics-series.v1`, shared with the Metrics pane through
`GET /api/verse/fleet/runs/metrics` (`series`). It streams the same
`<fleet runs dir>/metrics/jobs.jsonl` source as `phm fleet yield` and honors
`ASHLR_RUNS_DIR` or `--jobs <file>`. The 24 rolling one-hour intervals carry
merge counts by repo, launches and merges per launch, plus last-hour/24h totals.
MERGED outcomes use recorded `ts`, including reconciler rows; repeated PR URLs
count once at their earliest timestamp (repo/job identity when URL is absent).
Future rows are excluded. Empty readable files measure zero; unreadable or
interrupted reads produce null counts. Skipped invalid rows are counted.
Human actions are not recorded: merges per launch is a throughput ratio, not
autonomy or launch-cohort success. Merges may originate from earlier launches;
hours with no launches have null ratios. Series covers exactly 24 hours and
rejects `--hours`. Exit 0 means readable, 1 unreadable, 2 invalid arguments.

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

## Job yield (`jobs.yield.v1`)

RQ-FAMILYYIELDN18RQ8. `phm jobs yield [--since 24h] [--metrics <jobs.jsonl>] [--stop-list] [--json]`
says which kinds of jobs are worth a launch slot. The Metrics pane shows the
same report as the "Job yield" card, from `jobYield` on
`GET /api/verse/fleet/runs/metrics`. Read-only; exit 0, or 2 for bad arguments.

Run `phm jobs yield --stop-list` to print only the job kinds to stop, one per
line. It lists every `stop` family in report order, including those beyond the
top five, without headings or counts. No matches prints nothing. An unreadable
or interrupted read prints the unknown reason to stderr and exits 1, so a failed
read cannot look like an empty list. With `--json`, the full `jobs.yield.v1`
report stays unchanged, even when `--stop-list` is present.

`src/core/fleet/slot-yield.ts` exports the pure `jobYield(lines, now, hours)`,
`jobKind(id, repo?)`, `jobVerdict({ launches, running, merged })` and
`unknownJobYield(hours)`; `yieldTally(...).jobYield()` streams the same report.
`readJobYield(path, hours?, now?, read?)` in `metrics-series.ts` owns the read.
Rows used: `launch`, `finish` (`empty`), `precheck_skip`, `publish` and
`outcome` (`state`). Only launches inside the window count; a relaunched job is
several launches and a MERGED job is credited once.

```json
{ "schema": "jobs.yield.v1", "version": 1, "window_hours": 24, "known": true,
  "launches": 30, "merged": 9, "empty": 14, "skipped": 3, "stop_slots": 12,
  "summary": "12 of 30 launches went to 3 job kinds that merged nothing",
  "families": [{ "family": "RQ-PHX-RECUTCORE", "launches": 6, "running": 0,
    "empty": 6, "skipped": 0, "prs": 0, "merged": 0, "merged_per_launch": 0,
    "verdict": "stop", "reason": "0 merged from 6 launches, 6 empty" }],
  "stop_first": [{ "family": "RQ-PHX-RECUTCORE", "slots": 6, "merged": 0,
    "reason": "0 merged from 6 launches, 6 empty" }] }
```

Job kind (`family`) is the job id minus its trailing counter:

- `RQ-<CODE><n>A<digits>Q8` is `one-test filler <repo>`: the launch row's
  repo, else the id's code in lower case.
- A closing `Q8` stamp goes, with the leader's `N<day><letter>` before it.
- A last `-<digits>` or `-N<digits>` segment goes.
- A glued cycle goes: `C<digits>` at the end (`RQ-PHX-RECUTCOREC566` is
  `RQ-PHX-RECUTCORE`), else everything from the first digit after a letter.

Verdicts: `keep` at 0.3 merged per launch or more; `stop` when 6 or more
launches have ended and merged per launch is under 0.1; `watch` otherwise.
Launches still running never count toward `stop`. `families` sort stop, watch,
keep, most launches first; `stop_first` holds at most 5. `skipped` counts
precheck skip rows, which take no slot. With no launches `merged_per_launch` is
null. An unreadable or interrupted read gives `known: false`, null totals and
empty lists, never zero.
