# Observe local Codex session usage

From the repository root, watch the local personal Codex sessions directory
(`~/.codex-2`) and print usage samples followed by a summary:

```sh
npx tsx examples/agents/personal-usage-follow.ts --samples 5 --interval-ms 2000
```

`--samples` defaults to 2 (integer 2–60). `--interval-ms` defaults to 5000
(integer 1000–60000).

Stdout is JSON Lines: each sample records `type` (`"sample"`), `sampledAt`
an ISO timestamp, and `resource` (account resource data).  The final line
is a `summary` object with `status` (`"completed"` or `"cancelled"`),
`samples` count, `first` / `last` snapshots (each `observedAt` and
`usedPct`), and `weeklyUsedPctDelta` (percentage-point delta or `null`).
Exit codes: `0` completed, `2` invalid arguments, `1` observation
failure, `130` cancelled by SIGINT/SIGTERM.
