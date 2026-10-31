# Agent usage delta probe

From the repository root, sample a lane twice, five seconds apart:

```sh
npx tsx examples/agents/usage-delta-probe.ts --lane claude --interval-ms 5000
```

Both options are required. Lane names contain 1–80 ASCII letters, digits, dots, underscores or hyphens, start with a letter or digit, and must pass the ledger's private-text scrubber. The interval is an integer from 1000 to 60000 milliseconds. The workflow reads the existing local resource ledger twice in sequence; it makes no live provider calls, launches no work, and changes no state. The ledger owns its local sources, including its personal-session overlay and scrubbing rules.

Standard output is one versioned JSON object. `before` and `after` include sampling and ledger generation times, status and lane observation times, source health, and the selected lane's reported weekly usage percentage, six-hour token rate, running count, held state, window and source. A missing lane is `null`; individual unknown values stay `null`. Source health can be `healthy`, `missing`, or `degraded` and must be considered when interpreting results.

`changes.usage.state` is `advanced`, `unchanged`, `reset` (a lower percentage, possibly a window reset), `unknown` (including null usage, non-weekly windows or incompatible sources), or `missing` (a lane absent in either sample). `deltaPct` is percentage points only for unchanged or increased weekly observations; a reset has no negative spend. No quota is inferred. Token-rate and running changes are `increased`, `decreased`, `unchanged`, or `unknown`, with a numeric delta only when comparable. The observation timestamp uses the ledger's lane-specific timestamp when present, otherwise the status timestamp; `changes.observedAt` and `changes.statusAsOf` are `advanced`, `stale`, `reset` (moved backwards), or `missing`. A stale timestamp means values do not establish a fresh provider observation even if they differ. Usage and token rates from different sources or windows are not compared. Held values remain visible in each sample and are never overridden by this report.

Exit code `0` means a report was produced, including missing, stale or degraded data; it does not prove a provider meter moved. Invalid arguments produce JSON error `invalid_arguments` and exit `2`; an unexpected failure produces `probe_failed` and exit `1`. An interrupted wait produces `interrupted` and exit `130` for SIGINT or `143` for SIGTERM. Error objects do not include source contents or exception details.
