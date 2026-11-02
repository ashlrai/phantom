# Agent lane consistency report

From the repository root:

```sh
npx tsx examples/agents/lane-consistency.ts
npx tsx examples/agents/lane-consistency.ts --runs-dir /path/to/runs --wait-ms 1000
npx tsx examples/agents/lane-consistency.ts --help
```

This one-shot, read-only report compares the dispatcher status with the local host's live worker snapshot. It does not modify state, repair dispatch, kill processes, or call providers. The default runs directory is `~/.ashlr-runs`; `--wait-ms` optionally delays the single observation by 0–5000 ms. Interrupting the wait exits with code 130.

Standard output is one JSON object (`v: 1`). `observation.dispatch.lastTick` is the dispatcher's status timestamp; its `generatedAt` is the read time. `observation.workers.generatedAt` is the process snapshot time. Timestamps longer than 64 characters are reported as `null`. These observations are not atomic, and neither a match nor a mismatch proves freshness. The dispatcher overall and status source health and the workers source health remain visible independently.

`lanes` is the sorted union of observed lane names, limited to 100 rows; `omittedLanes` records the number excluded. Each row gives `reported` dispatcher running count, `workers` live count, `delta` (reported minus workers), and `consistency` (`matched`, `mismatched`, or `unknown`). An absent dispatcher lane is unknown, even when status is healthy. A healthy process snapshot with no workers for a lane gives zero. If status is missing or degraded, process enumeration is unavailable, or a worker's lane cannot be safely represented, the affected counts and comparison are `null`/`unknown`. Degraded status may retain lane names without presenting partial counts as authoritative. No process command lines or worker details are included.

Exit code 0 means the report was produced, including when sources are unavailable; inspect health and `consistency` before acting. Code 1 indicates an unexpected reader or output failure, and 2 indicates invalid arguments. Errors are JSON on standard error, without source contents. The tool makes no admission or repair decision.
