# Agent capacity report

From the repository root, run:

```sh
npx tsx examples/agents/capacity-report.ts
npx tsx examples/agents/capacity-report.ts --runs-dir /path/to/runs
npx tsx examples/agents/capacity-report.ts --help
```

The default directory is `~/.ashlr-runs`. This reads the same local projections as Phantom's desktop; it does not launch work or change targets. No provider calls are made.

Standard output is one JSON object, versioned by `v` (currently `1`). `observation.runs` contains the runs reader's `generatedAt`, `lastTick`, overall `sourceState` and per-source `sources`; `observation.ledger` contains its `generatedAt`, `asOf` and `sources`. `paused` and `switches` come from runs. Source health is `healthy`, `missing`, or `degraded`; missing or degraded data must not be interpreted as available capacity.

`lanes` is the sorted union of both projections. Each row contains `lane`, `join`, `running`, `target`, `queued`, `held`, `heldReason`, and `usage`. Dispatch values come from runs; absent values are JSON `null` (unknown), never zero or false. `usage` is `null` when the ledger has no corresponding row. Otherwise it contains the ledger's `window`, `usedPct`, `creditsRemaining`, `resetAt`, `burnPctPerHour`, `tokensPerHour6h`, `projectedExhaustion`, `source`, and the runs reader's `tokensLastHour`; individual unknown values are `null`. The window comes from the ledger; do not assume a particular provider window.

`join` is `matched` only when both rows and observation times exist, their times denote the same instant, and their running, target and held values agree. It is `mismatched` when those observations disagree and `unknown` when a required observation is absent. Values remain attributed to their separate readers even when the join is not matched; do not treat them as a single coherent snapshot. A matched join does not guarantee freshness or override a hold, pause, switch, or unhealthy source. The tool does not calculate available slots or make admission decisions.

Exit codes: `0` for a report or help (including reports with missing/degraded sources), `1` if a reader unexpectedly fails, and `2` for invalid arguments. Errors go to standard error without source contents.
