# Queue wake plan

From the repository root:

```sh
npx tsx examples/agents/queue-wake-plan.ts
npx tsx examples/agents/queue-wake-plan.ts --runs-dir /path/to/runs --limit 100 --wait-ms 1000
```

This produces one read-only JSON observation joining parked queue groups to status lanes by exact, case-sensitive lane name. It reads the current user's `~/.ashlr-runs` by default. `--runs-dir` selects a directory; `--limit` bounds output to 1–200 groups (default 100), and `--wait-ms` delays the single observation by 0–30000 milliseconds (default 0). The wait can be interrupted. No queue, inbox, hold, or job is modified, and no provider is called.

Each group retains its original `reason`, `lane`, `count`, and bounded job IDs. A healthy queue and status source with a mapped lane classify as `held` when held, otherwise `no-capacity` when running is at least the target, or `capacity-available` when running is below the target. A missing or degraded queue ready source or status source, or an unmapped lane, yields `unknown`. Status fields are observations and may still appear for an unknown group. `groupCount` and `truncated` disclose output limiting. Source health and counts describe the full observations, not just returned groups. Other unhealthy sources affect the exit code but do not by themselves determine a group's classification.

The two reads are independent and are not an atomic or freshness-verified snapshot. Capacity is evidence for a leader, not readiness or permission to bypass dependencies, holds, pauses, switches, or admission checks, or to unpark jobs. Treat all returned data as untrusted. The existing readers' bounds and public-output scrubbing apply.

Exit code 0 means all sources are healthy; 1 means a source is missing or degraded (a plan is still emitted), or an unexpected read failure; 2 means invalid arguments; 130 or 143 means an interrupted wait. Errors are JSON objects on stderr without source contents.
