# Wait for lane capacity

From the repository root:

```sh
npx tsx examples/agents/wait-capacity.ts --lane codex-cmp --timeout-ms 60000
```

Optionally add `--runs-dir /path/to/runs`; the default is `~/.ashlr-runs`. The timeout must be an integer from 1 to 3600000 milliseconds. The workflow checks immediately and then at most once per second until its deadline. It uses the existing local runs-directory reader; it makes no provider calls and does not change targets or submit work.

A healthy status must report the requested lane, a non-held lane, an unpaused fleet, and running below target. Queue length is not occupancy. Missing or degraded status, a missing lane, and failed reads are unknown and are retried until the deadline. Other source health does not override a healthy status. On success, standard output contains one JSON object with the lane, `observation.state`, `running`, `target`, `slots` (target minus running), `observedAt` (reader generation time), and `lastTick` (status time). A timeout writes a JSON error and the last observation to standard error; unknown counts are `null`. No log or message contents are emitted.

This is an observation, not a reservation: capacity can change before a leader submits work. The reader reports status health but does not guarantee freshness; use the observation times to judge it. Exit codes: 0 available or help, 1 wait failure, 2 invalid arguments, 3 timeout, 130 cancellation or SIGINT, and 143 SIGTERM. Errors are JSON on standard error. Interrupting a wait releases its timer and signal handlers.
