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
`read(path): Promise<string | { text: string; truncated: boolean } | null>`
and `now(): number`. Default source:
`~/.ashlr-runs/metrics/jobs.jsonl`. The ledger is append-only, so the default
read keeps its newest bounded tail — the same 16 MiB window
`readLedgerTail` gives every other jobs-ledger reader — rather than refusing
an oversized file; a cut tail marks the evidence degraded because retained
rows cannot prove complete window coverage. Non-files and unreadable paths
still read as missing. JSONL invalid rows also mark evidence degraded.
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

RQ-FAMILYYIELDN18RQ8. `phm jobs yield [--since 24h] [--metrics <jobs.jsonl>] [--stop-list | --stop-file [--ttl-hours N] [--out PATH] [--dry-run]] [--json]`
says which kinds of jobs are worth a launch slot. The Metrics pane shows the
same report as the "Job yield" card, from `jobYield` on
`GET /api/verse/fleet/runs/metrics`. Read-only; exit 0, or 2 for bad arguments.

Run `phm jobs yield --stop-list` to print only the job kinds to stop, one per
line. It lists every `stop` family in report order, including those beyond the
top five, without headings or counts. No matches prints nothing. An unreadable
or interrupted read prints the unknown reason to stderr and exits 1, so a failed
read cannot look like an empty list. With `--json`, the full `jobs.yield.v1`
report stays unchanged, even when `--stop-list` is present.

### Job stop file (`jobs.stop-file.v1`)

RQ-STOPFILEN18XQ8. `phm jobs yield --stop-file [--ttl-hours N] [--out PATH] [--dry-run] [--json]`
writes every `stop` kind to the job stop file, which the fleet's precheck reads
before any model call. Rows are `<ERE on job id>\t<until unix epoch>\t<reason>`;
`#` lines are comments and rows past their epoch are ignored. Each tool row is
followed by a `# auto:phm-yield` line. The path is `--out`, else the
`ASHLR_JOBS_STOP_FILE` environment variable (absolute). There is no default:
with neither, the path is unknown and only `--dry-run` runs.

- Pattern: anchored and escaped, built from the job kind (`familyPattern`). A
  kind with no safe pattern, or whose pattern would match another kind's job in
  the window, is not written and is listed in `unsafe` with the reason.
- `until` is now plus `--ttl-hours` (default 24, at most 72). Reason is
  `<kind>_<merged>of<launches>`, spaces as dashes.
- A kind is `stop` only with 6 or more ended launches, merged per launch under
  0.1 and no merge in its last 3 launches. `--stop-list` uses the same verdict.
- The write is a temp file plus rename. Hand-written rows and comments stay as
  they are. Expired tool rows are removed; live tool rows stay until they
  expire, or are replaced by a new row for the same pattern.
- Exit 0; 1 when the yield, the path or the file is unknown (nothing written);
  2 for bad arguments. JSON: `{schema,version,path,dry_run,written,ttl_hours,
  yield_known,error,rows:[{family,pattern,until,reason}],unsafe:[{family,why}],
  kept_hand,kept_auto,dropped_expired}`.

`src/core/fleet/stop-file.ts` exports `stopFilePath(env?)`, `familyPattern(family, ids?)`,
`stopRows(parts, now, ttlHours?)`, `parseStopFile(text)`, `planStopFile(text, rows, now)`,
`readStopFileText(path)`, `writeStopFile(path, text)`, `readLiveStops(path, now)`,
`stoppedBy(rows, ids)` and `stoppedFamilies(rows, now)`. `readJobYieldParts(...)` in
`metrics-series.ts` and `yieldTally(...).jobYieldParts()` return `{ report, ids }`.
`shouldEmitRecut` skips with code `stop-file` when `stopRow` is set;
`readRecutGateFacts` sets it from a live row matching the job id or kind
(`stopFile` option, default `stopFilePath()`), and `recut.check.v1` facts carry
`stop_file_row`. `readMetricsPanel(runsDir?, now?, stopFile?)` adds
`stopped: [{family,why,until,expires_in_s,auto}] | null` (null is unknown), shown
as "Stopped families" on the Job yield card.

`src/core/fleet/slot-yield.ts` exports the pure `jobYield(lines, now, hours)`,
`jobKind(id, repo?)`, `jobVerdict({ launches, running, merged, recentMerge? })`,
`hasRevertEvidence(row)` and `unknownJobYield(hours)`; `yieldTally(...).jobYield()`
streams the same report. `readJobYield(path, hours?, now?, read?)` in
`metrics-series.ts` owns the read.
Rows used: `launch`, `finish` (`empty`), `precheck_skip`, `publish` and
`outcome` (`state`). Only launches inside the window count; a relaunched job is
several launches and a MERGED job is credited once. A merge recorded as reverted
(`hasRevertEvidence`: `reverted:true`, a parseable `reverted_at`/`revertedAt`
stamp, a `revert`/`reverted` event name or terminal state field — the router
outcome fold's vocabulary) is credited as `reverted`, never as a held merge;
an explicit `reverted:false` is not evidence, and a terminal REVERT/REVERTED
outcome state counts as reverted on its own.

```json
{ "schema": "jobs.yield.v1", "version": 1, "window_hours": 24, "known": true,
  "launches": 30, "merged": 9, "reverted": 2, "empty": 14, "skipped": 3, "stop_slots": 12,
  "summary": "12 of 30 launches went to 3 job kinds that merged nothing",
  "families": [{ "family": "RQ-PHX-RECUTCORE", "launches": 6, "running": 0,
    "empty": 6, "skipped": 0, "prs": 0, "merged": 0, "reverted": 0, "merged_per_launch": 0,
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
Launches still running never count toward `stop`, and a reverted merge is not
a recent merge either. `families` sort stop, watch,
keep, most launches first; `stop_first` holds at most 5. `skipped` counts
precheck skip rows, which take no slot. With no launches `merged_per_launch` is
null. An unreadable or interrupted read gives `known: false`, null totals and
empty lists, never zero.

## Family yield (`fleet.family-yield.v1`)

RQ-FAMYIELDN19NQ8. `phm fleet yield [--hours 24] [--metrics <jobs.jsonl>] [--json]`
(`--since 24h` still works) judges coarse job families, so a generator that
spreads its launches over many areas is judged as one. A family is the job id
with its numbers collapsed (`collapseFamily`): `RQ-PHX-RECUTAPIC606` and
`RQ-PHX-RECUTCLIC607` are `RQ-PHX-RECUT*C*`, `RQ-MD12A111815Q8` is `RQ-MD*A*Q8`.
Families of one job id are listed under `single`.

- Verdict: `stop` with 6+ finished runs and merged per launch under 0.2;
  `watch` under 0.4; `keep` otherwise. Merged per launch counts held merges
  only: a merge recorded as reverted (`hasRevertEvidence`, see job yield) is
  `reverted`, its tokens still count as wasted, and it never counts as a
  recent merge.
- Order: most `wasted_tokens` (tokens on runs that did not merge) first.
- Tokens: missing counts stay null (unknown). `tokens_unknown` counts ended runs
  without a count; `wasted_tokens_partial` marks a lower bound.
- Stop rows: one per `stop` family, `<anchored ERE>\t<until epoch s, now + 24 h>\t<reason>`,
  in the job stop file format; `phm jobs yield --stop-file` keeps hand-pasted rows.
- An unreadable file is `known: false` with null totals.

`src/core/fleet/family-yield.ts` exports `collapseFamily(id)`, `familyVerdict(row)`,
the pure `familyYield(lines, now, hours)`, `familyYieldFromRuns(runs, now, hours, lanesTiers?)`,
`readFamilyYield(path, hours, now, read?)` and `unknownFamilyYield(hours)`; it parses
through `yieldTally(...).runs()` (slot-yield.ts), which returns each launch as a
read-only `YieldRun` with `last`, its newest row time.

```json
{ "schema": "fleet.family-yield.v1", "version": 1, "window_hours": 24, "known": true,
  "launches": 14, "merged": 4, "reverted": 1, "wasted_tokens": 537000, "wasted_tokens_partial": false,
  "families": [{ "family": "RQ-PHX-RECUT*C*", "jobs": 7, "launches": 7, "finished": 7,
    "empty": 6, "prs": 1, "merged": 1, "reverted": 0, "merged_per_launch": 0.14, "tokens_total": 550000,
    "tokens_unknown": 0, "tokens_per_merged": 550000, "wasted_tokens": 510000,
    "wasted_tokens_partial": false, "last_seen": "2026-11-18T15:00:00.000Z", "verdict": "stop",
    "reason": "1 merged of 7 launches, 6 empty, 510000 tokens on unmerged runs" }],
  "single": [], "stops": [{ "family": "RQ-PHX-RECUT*C*", "pattern": "^RQ-PHX-RECUT[A-Z]+C[0-9]+$",
    "until": 1795111200, "reason": "yield_1of7_empty6", "line": "<pattern>\t<until>\t<reason>" }],
  "lanes": [], "tiers": [] }
```

Hermetic coverage: `test/fleet-family-yield.test.ts`.

## Recut cycle plan (`recut.plan.v1`)

RQ-RECUTPROMPTN18ZQ8. `phm recut plan [--json] [--prs <dirty-landed.json>] [--base master] [--metrics <jobs.jsonl>] [<area>...]`
says, per recut area (`RECUT_AREAS` in `recut-gate.ts`, default all 13), whether the
recut generator should write a job this cycle. Read-only; exit 0, or 2 for bad usage.

- The gate decides first: `shouldEmitRecut` over `readRecutGateFacts`, so the stop
  list, a live stop-file row (`ASHLR_JOBS_STOP_FILE`) and the empty streak all skip.
- A passing area then needs an eligible PR: an open conflicting PR from
  `phm fleet dirty-landed` (or `--prs`, a saved `fleet.dirty-landed.v1` report) that
  `recutDropJob` accepts, with a remaining path in the area. Zero skips with code
  `no-eligible-pr`. An unreadable list, or zero from a list cut short at its page
  limit, is unknown (`eligible: null`) and never skips.
- Human output is one line per area: `emit <area>: <reason>` or `skip <area>: <reason>`.
- JSON: `{schema,version,generated_at,emit,skip,prs:{source,known,complete},
  stop_file:"unset"|"unreadable"|"read",areas:[{area,family,emit,code,reason,eligible,prs}]}`.

`phm recut prompt <job-id> --lane <lane> --tier <tier> [--repo phantom] [--task <text>]`
reads a prompt on stdin and prints it with the standard task line
`<job-id> (P1, pool=<lane>, tier=<tier>, repo=<repo>): <task>` as its first non-blank
line; the rest is unchanged, and a prompt already starting with `<job-id> (` is printed
as it is. The launch precheck and stop list only see a job through that line.

`src/core/fleet/recut-plan.ts` exports the pure `recutTaskLine(input)`, `promptTask(prompt)`,
`withTaskLine(prompt, line, id)`, `eligibleRecutPrs(prs, area, now)` and
`planRecutArea(area, family, gate, list, now)`; `recut-gate.ts` exports `AREA_PATHS` and `RECUT_AREAS`.
Hermetic coverage: `test/recut-plan.test.ts`.
