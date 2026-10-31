# Leader progress check

From the repository root, save a public observation and compare a later one:

```sh
npx tsx examples/agents/leader-progress-check.ts --save /tmp/leader-before.json
npx tsx examples/agents/leader-progress-check.ts --before /tmp/leader-before.json --save /tmp/leader-next.json
```

Alternatively, take two observations in one invocation (this waits 30 minutes):

```sh
npx tsx examples/agents/leader-progress-check.ts --wait-seconds 1800
```

The default sources are in `~/.ashlr-runs`; use `--runs-dir ABSOLUTE_PATH` for another local runs directory. `--wait-seconds` accepts integers from 1 through 3600 and cannot be combined with `--before`. `--help` prints usage as JSON. No baseline gives `insufficient-history`; it can be saved for a later comparison. The tool reads the existing journal and fleet projections; it does not launch, repair or execute anything from the logs.

The JSON report identifies newly observed claims and PR publications after the baseline timestamp. Either is `progress`. With no observed progress, a 30–60 minute interval and healthy claim and metrics sources at both observations yields `incident`, provided the claim and current publication projections are not saturated and newly visible rows have no ambiguous timestamps; other cases yield `insufficient-history`. This is a signal for a human or agent to investigate, not proof that every leader pass launched work. Publications are not merges. Status is based on observed data, even if other sources are degraded; inspect `sources`.

Ingest entries do not carry timestamps in the public projection. The report joins the newest-first bounded rows against the prior snapshot and includes newly visible `reject` rows with their original reader-scrubbed reasons. `ingest.continuity: unknown` means the bounded sequences could not be joined, a row was redacted, or a source was unhealthy, so absence of listed rejections is not evidence of none. Identical repeated rows, rotations, the 30-row ingest limit, the 50-publication limit, and the metrics reader's one-hour/one-MiB tail can hide events. A healthy source is not a guarantee of complete history, and comparison cannot detect all truncation or replacement.

`--save` atomically replaces the named file after emitting the report, with mode 0600 for the new file. The versioned snapshot contains timestamps, health flags and hashes of bounded public rows, not log messages. Treat it as local evidence: it is not authenticated and must be explicitly supplied with `--before`. Missing, malformed, oversized or future baselines fail without resetting or saving. Exit 0 means a report was produced (including incident or insufficient history), 2 means invalid arguments, 1 means a baseline, observation or save error, and 130 means a wait was interrupted. Errors are JSON; if saving fails, an error follows the already emitted report. SIGINT and SIGTERM interrupt waits and listeners are removed on completion.
