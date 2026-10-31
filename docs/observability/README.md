# Engineering cycle dashboard

Import [cycle-dashboard.json](cycle-dashboard.json) through Grafana's dashboard
import screen and select a Prometheus datasource. The dashboard shows stage
p50/p90, queue wait p50/p90 and CI execution p50/p90 over seven days by default.
Repository and pool filters apply to every panel. It requires classic Prometheus
histograms from an external exporter; Phantom does not currently emit these
metrics. Importing this file does not install an exporter or enable collection.

The router task references a separate spec that is absent from this checkout.
The following is the explicit integration contract used by this dashboard;
confirm metric names with that spec before connecting a production exporter.

| Histogram (seconds) | Observation boundaries |
| --- | --- |
| `phantom_cycle_stage_duration_seconds` | Stage start to stage completion, with a `stage` label naming the stage |
| `phantom_cycle_queue_wait_seconds` | Queue admission to worker start, excluding worker execution |
| `phantom_cycle_ci_duration_seconds` | CI run start to terminal completion, excluding CI queue wait |

All three histograms must carry `repo` and `pool` labels with consistent values;
the stage histogram supplies the filter choices. Attribute CI observations to
the originating work item's pool. Emit standard `_bucket`, `_sum` and `_count`
series, including a `+Inf` bucket. Use identical bucket boundaries across
exporters, chosen to resolve durations from seconds through hours. Labels must
be bounded categories, never task IDs, PR IDs, prompts or credentials.

Observe each completed stage attempt, queue admission and CI run exactly once.
Retries are separate attempts. Include terminal failures and cancellations when
both boundary timestamps exist; omit incomplete or invalid intervals, including
negative durations. Never synthesize zero for missing timestamps. These panels
measure completed observations, so ongoing waits and running stages are absent.
They do not measure proposal-to-merge time or establish release readiness.

Queries apply `rate` before summing histogram buckets, preserving counter reset
handling, and retain `le` for percentile estimation. Stage panels also retain
`stage`; queue and CI panels aggregate across selected repositories and pools.
Percentiles describe the combined observation population, not averages of
per-worker percentiles. Grafana's `$__rate_interval` adapts the rolling sample
window to the datasource scrape interval and zoom level. A point is a rolling
window estimate, not the percentile of the entire selected seven days.

Missing series, empty populations and insufficient samples display as gaps or
“No observations”; gaps are never connected or filled with zero. Inspect the
corresponding `_count` rates in Prometheus before interpreting sparse tails.
The dashboard contains no alert rules or external links.

Validate the dashboard contract locally with an isolated home:

```sh
HOME=$(mktemp -d) npx vitest run test/cycle-dashboard.test.ts
```

# Hop efficiency insights

Read tokens per merged PR and merged PRs per dollar from a local hop-event
journal. From a source checkout:

```sh
npm run dev -- pulse --window 7d --json
```

The additive `hopEfficiency` object appears in `pulse --json`, `GET /api/pulse`
and the activity rollup. `buildSnapshot()` exposes the same object at
`activity.hopEfficiency` in dashboard snapshot JSON. Existing transcript usage
and budget totals remain independent of this ledger, preventing double counting.
The request cache can serve the previous rollup while refreshing it.

## Input contract

The read-only collector reads `~/.ashlr/observability/hops.jsonl`, resolving the
current user's home on each call. This change defines the version 1 interchange
contract; existing run/transcript and fleet-bus producers do **not** automatically
populate this journal. An upstream adapter must supply metadata-only JSONL rows.
Missing input is reported as `missing`, with unknown ratios, rather than a
claim of zero cost or zero engineering output. No credentials or providers are
needed to read a journal.

Each row contains `schemaVersion: 1`, a nonblank stable `id` (up to 256
characters), a canonical UTC timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`), a repository
slug (`owner/name`, case insensitive, up to 256 characters), and one kind:

```jsonl
{"schemaVersion":1,"id":"hop-1","kind":"hop.completed","ts":"2026-10-25T10:00:00.000Z","repo":"example/phantom","tokensIn":100,"tokensOut":50,"costUsd":2}
{"schemaVersion":1,"id":"merge-7","kind":"pr.merged","ts":"2026-10-25T14:00:00.000Z","repo":"example/phantom","prNumber":7}
```

- `hop.completed` records incremental usage for one completed attempt, including
  failed, cancelled and unmerged work. It must not contain cumulative session
  totals already recorded by another hop. Input and output tokens are
  nonnegative safe integers. `costUsd` is a nonnegative finite recorded dollar
  amount. Missing or `null` accounting values mean unknown; explicit `0` means
  measured zero. Adapters own pricing, including any cache costs; the collector
  does not invent prices or subscription allocations.
- `pr.merged` records a positive integer `prNumber`. Its timestamp must be the
  actual merge time, not the delivery time of a notification. Emit this only
  from confirmed merge evidence. A commit, task completion or generic fleet
  notification does not establish a merge.

Adapters must keep prompts, responses, tool arguments, credentials and file
contents out of the journal. The parser allowlists accounting fields; output
contains aggregate metrics and repository slugs, never raw events or event ids.

## Metric definitions and evidence

Metrics describe the inclusive interval `[since, until]`. They measure interval
productivity, **not** lifetime usage attributed to the cohort of PRs merged in
that interval. Work on an unfinished PR counts in usage; a PR whose work occurred
before the interval counts only as a merge in the interval.

| Field | Meaning |
| --- | --- |
| `totals.hops` | Unique hop attempts inside the interval and project scope |
| `totals.mergedPrs` | Unique repository/PR-number pairs merged in the interval |
| `totals.tokens` | Sum of input + output for hops where both are known |
| `totals.costUsd` | Sum of known recorded hop costs |
| `totals.hopsWithTokens`, `totals.hopsWithCost` | Accounting coverage for the two subtotals |
| `totals.tokensPerMergedPr` | Tokens / merged PRs, when token coverage is complete and merges > 0 |
| `totals.mergedPrsPerDollar` | Merged PRs / dollars, when cost coverage is complete and dollars > 0 |
| `byRepo` | Same fields per repository, sorted by canonical slug |

Check `sourceState`, `status`, coverage and `diagnostics` alongside the ratios.
Subtotals with incomplete coverage are not total usage. An overflowed subtotal
is `null`. Ratios are `null` for unknown coverage, no hops, or a zero denominator;
they never emit NaN or Infinity. With known positive cost and zero merges, PRs
per dollar is `0`. With known zero tokens and a merge, tokens per merged PR is `0`.
Token and dollar coverage are independent: one ratio can be known while the other
is unknown.

`status` is `complete`, `partial`, `empty`, `missing` or `unavailable`. Empty
means readable input with no matching events. Partial means missing accounting,
numeric overflow, merge-only input, or invalid/conflicting evidence. A malformed
row or conflicting id conservatively suppresses all ratios, including per-repo
ratios, since its attribution cannot be trusted. Diagnostics include invalid,
duplicate, conflicting and excluded event counts.

Repeated ids are deduplicated within each repository; reuse the original id on
delivery retries. Conflicting payloads for the same id are excluded. Merge rows
with different ids still count once per repository/PR-number pair, using the
earliest timestamp **before** interval filtering. Retain that original merge
evidence when rotating journals so later notifications cannot earn fresh credit.
Future and old events are excluded. No merge is inferred from usage.

`--project owner/name` and `--project name` filter hops exactly, ignoring case.
For indexed checkout paths or other matching index filters, the rollup reuses
indexed GitHub origins to select canonical repository slugs. An unindexed path
or an indexed repo without a recognized GitHub origin has no matching hops;
the collector never guesses from a worktree directory name or probes a remote.

The collector reads at most 8 MiB from a regular file. Missing input is distinct
from unreadable, oversized or concurrently resized input (`unavailable`); it
never silently summarizes a tail. Keep the journal bounded while retaining the
selected interval's full usage and original merge evidence. No automatic
rotation, backfill, remote fetch or accounting completeness attestation occurs.

## Verification

The fixture in `test/fixtures/hop-events.jsonl` covers multiple repositories,
failed work, retries and interval exclusions. Run from the repository root:

```sh
HOME="$(mktemp -d)" npx vitest run test/hop-rollup.test.ts
```

Tests also exercise malformed and missing data, numeric limits, the file reader,
project-path mapping and real `pulse --json` serialization. Dashboard projection
coverage lives in `test/m13.dashboard.test.ts`.
