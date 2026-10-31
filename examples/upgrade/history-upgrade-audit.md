# History upgrade audit

From the root of a Phantom checkout matching the installed version, with its dependencies already available:

```sh
npx tsx examples/upgrade/history-upgrade-audit.ts --max-gap-minutes 5
npx tsx examples/upgrade/history-upgrade-audit.ts --max-gap-minutes 5 --hours 48
npx tsx examples/upgrade/history-upgrade-audit.ts --help
```

The command reads the installed desktop's existing fleet history using `readRunsHistory` and its normal path resolution (`ASHLR_RUNS_HISTORY_FILE`, then `ASHLR_HOME`, then `~/.ashlr`). It never takes, backfills, appends, compacts, or rewrites samples. Run it after a desktop restart to inspect retained observations and see where monitoring stopped. Sampling happens only while something is watching, so a gap describes missing observations, not its cause or proof of lost data.

`--max-gap-minutes` is required and must be positive; select a threshold appropriate for the monitoring cadence. `--hours` defaults to 24 and accepts whole hours from 1 through 168, the reader's bounds. Except for help, stdout contains one JSON object. Completed audits use schema `phantom.history-upgrade-audit.v1`: sample and distinct-instant counts, first and last observations, window, threshold, source health, dropped rows, future sample count, and gaps. Samples are sorted by instant without changing the source. Duplicate instants count as samples but not independent instants. Future-dated rows are excluded from the window and prevent verification. Gaps strictly exceeding the threshold include the window edges and intervals between observations; at most 100 are returned, with the total and a truncation flag. A gap at a window edge may reflect retention or a monitoring start/stop, not an actual outage.

Exit codes:

- `0`: verified: at least two distinct observations, healthy source, no dropped or future rows, and no gap above the threshold; also help.
- `1`: at least two distinct observations and an observed gap above the threshold, or an unexpected read failure. A gap remains visible even if the source is degraded; dropped rows could have contained observations in that gap.
- `2`: invalid or missing arguments.
- `3`: insufficient evidence to verify continuity: fewer than two distinct observations, a missing or degraded source, dropped rows, or future-dated rows, when no mismatch was established.

A successful audit is bounded to the selected window and threshold; it cannot establish continuity before that window, identify why observations are missing, or prove that an upgrade preserved samples that had already disappeared. Errors are static JSON and do not disclose filesystem paths.
