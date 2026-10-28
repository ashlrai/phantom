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

| Gauge (unitless, [0,1]) | Observation |
| --- | --- |
| `phantom_router_lane_reward` | Mean routing reward per `policy` label (`static` or `bandit`), as reported by `phm queue bandit` replays or a live router-bandit export |

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
per-worker percentiles. The lane-reward gauge carries `repo` and `pool`
labels from the outcome records it summarizes plus a `policy` label bounded
to `static` (the logged router's measured reward) and `bandit` (the
Thompson-sampling replay's counterfactual estimate). Emit the replay's
`before.meanReward` as `policy="static"` and `after.meanReward` as
`policy="bandit"`; absent or null means remain missing, never zero. See
[docs/BANDIT-ROUTER.md](../BANDIT-ROUTER.md) for the reward formula, the
rejection-sampling estimator behind `after`, and the honest limits of the
estimate. Grafana's `$__rate_interval` adapts the rolling sample
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
