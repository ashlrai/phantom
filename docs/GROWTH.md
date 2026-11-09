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
| PRs opened | A complete pull export (`--prs`) | No complete export. Fleet proposals are not opened pull requests |
| PRs merged | That export's `mergedAt`, otherwise PR urls on MERGED ledger rows | Neither source was read |
| Releases | None yet | Always, until a local `publishedAt` series exists. `gh` is not called |
| Lane utilization | `usage-readings.log` `pctUsed` | No journal reading. A sensor snapshot is not a trend. Empty buckets stay gaps |
| Cost per merged PR | `scorecard-history` `costPerMergedChangeUsd` | No snapshot, or the range is `1H` or `1D` (snapshots are daily) |
| Bottleneck trend | None yet | Always. `bottlenecks.v1` `before`/`after` is not a time series |

A ledger that was read and recorded no merges is a real zero. Unknown stays null. Each missing field is also a `growth.*` blind spot on `phm world --json`. A daily source that cannot fill an hourly range is `no data source` for that range only; the blind spot remains only when no reading exists at all.

Exit 0 report, 1 unreadable pull file, 2 bad usage.

```sh
HOME=$(mktemp -d) npm run test:ci -- test/growth-series.test.ts
```
