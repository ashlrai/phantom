# Lane health

Every lane card on the Fleet screen shows four numbers over the last 12 hours:
calls, error rate, p50 latency and the deployed commit. One command prints the
same numbers:

```sh
phm lanes health --json
```

Example (trimmed):

```json
{"schema":"lanes.health.v1","window":{"hours":12},"commit":"3f9a1c07d2e4",
 "lanes":[{"lane":"codex","calls":14,"errorRate":0.07,"latencyP50Ms":612000,
 "latencyP95Ms":1900000,"commit":"3f9a1c07d2e4",
 "stuck":[{"runId":"r-81","repo":"ashlrai/phantom","phase":"producing","phaseAgeMs":2820000,"timeoutMs":2700000}]}]}
```

Without `--json` the command prints one line per lane, for example
`codex: 14 calls · 7% errors · 10m p50 · commit 3f9a1c07d2e4  [stuck · producing 47m]`.

## What each number means

- **Calls**: runs that started on the lane inside the window.
- **Error rate**: runs that ended `failed` divided by runs that finished. It is
  `null` ("unknown") until a run in the window has finished.
- **Latency**: start-to-end time of finished runs (p50 and p95); `null` until
  one has finished.
- **Commit**: the git commit of the Phantom build serving the view. It is
  `null` ("unknown") for an install with no git checkout; it is never guessed.

Both the screen and the CLI derive these from the same live snapshot as
`GET /api/verse/fleet/live`, so they agree. Nothing shown is a credential, and
output goes through the public-JSON scrubber.

## Stuck runs

A run that stays in one phase past its timeout gets a **stuck** badge with the
phase and how long it has been there, instead of silently hanging. Timeouts:
queued 30m, producing 45m, verifying 20m, judging 10m, landing 10m, reverting
10m. `parked` and `watching` wait on the world by design and are never stuck.
A run with no readable phase start is not judged.
