# Growth charts

`phm growth --json` prints the series the desktop Growth view charts. The view and the command read one projector, `growth.series.v1`.

```sh
phm growth --json
phm growth --range 1W --json
phm growth --prs /absolute/pulls.json --json
```

Ranges are `1H`, `1D` (the default), `1W`, and `1M`. The desktop polls `GET /api/verse/growth?range=` every 10 seconds while Growth is visible.

| Series | Source | When it is `no data source` |
| --- | --- | --- |
| Merges per hour | `~/.ashlr-runs/metrics/jobs.jsonl` MERGED outcomes | The file is missing, unreadable, or larger than 32 MiB |
| PRs opened | `metrics/growth-pulls-1d.json` for 1H and 1D. `metrics/growth-pulls-hourly.jsonl` for 1W and 1M | No complete export. Fleet proposals are not opened pull requests |
| PRs merged | That export's `mergedAt` or hourly counts, otherwise PR urls on MERGED ledger rows | Neither source was read |
| Releases | `metrics/growth-releases.jsonl` rows with `publishedAt` | The file is missing. `gh` is not called |
| Lane utilization | `usage-readings.log` `pctUsed` | No journal reading. A sensor snapshot is not a trend. Empty buckets stay gaps |
| Cost per merged PR | `metrics/growth-cost-hourly.jsonl` `costPerMergedPrUsd`, labeled metered lanes. `scorecard-history` is only the daily fallback | The hourly file is missing and there is no daily scorecard for 1W or 1M. Hours without a cost stay gaps |
| Bottleneck trend | None yet | Always. `bottlenecks.v1` `before`/`after` is not a time series |

Engineering Ops writes those metrics files every 15 minutes, with no model call. `growth-exports-status.json` is the freshness clock. A series is stale when that clock is more than 30 minutes old: the chart still draws the points and says so, and the world-model field is stale rather than fresh. `phm world` and `GET /api/verse/growth` read `growth-pulls-1d.json` when it is present, so `growth.pullsOpened` is not a blind spot. These metrics files allow 8 MiB. `readJsonFile` stays at 256 KiB.

A ledger that was read and recorded no merges is a real zero. Unknown stays null. Each missing or stale field is also a `growth.*` blind spot on `phm world --json`. A daily source that cannot fill an hourly range is `no data source` for that range only; the blind spot remains only when no reading exists at all.

Exit 0 report, 1 unreadable pull file, 2 bad usage.

```sh
HOME=$(mktemp -d) npm run test:ci -- test/growth-series.test.ts
```
