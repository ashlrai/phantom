# Job snapshot

From the repository root, with dependencies installed:

```sh
npx tsx examples/agents/job-snapshot.ts --job RQ-PHX-EXAMPLE
npx tsx examples/agents/job-snapshot.ts --help
```

The command reads the current user's `~/.ashlr-runs` using the same reader and defaults as the desktop. It accepts one explicit job ID and no path override. Except for help, stdout is one JSON object followed by a newline. On a completed read this is the unmodified `fleet.job.v1` desktop projection, including worker provenance, source health, and a bounded, scrubbed log tail. Missing individual sources are normal; inspect `sources` for details. Prompt contents and worktree paths are not returned.

Exit codes:

- `0`: projection returned with at least one visible piece of job evidence and no degraded source; also used for help.
- `1`: unexpected reader failure; stdout contains a generic JSON `error`.
- `2`: missing or invalid arguments or job ID; stdout contains a JSON `error`.
- `3`: projection returned, but all tracked sources are missing and neither prompt nor notes/body evidence is visible. The reader cannot distinguish a nonexistent job from an inaccessible or otherwise unobserved one.
- `4`: projection returned with at least one degraded source, even if other sources are available.

An exit code of `3` or `4` still includes the projection so callers can inspect the available data. A missing publish record alone does not mean failure, since a job may still be running.
