# Agent job changes

From the repository root, inspect a fleet job using the same bounded reader as
the Phantom desktop:

```sh
npx tsx examples/agents/job-changes.ts --job RQ-EXAMPLE
```

The command accepts exactly `--job <fleet-job-id>`; it does not accept a
worktree or path. It reads the local job record and writes one JSON object to
stdout. A successful read is the reader's `fleet.job.changes.v1` object:
`generatedAt`, `job`, `state`, `baseSha`, `files`, `totals`, and `truncated`.
Each file has `path`, `status`, `added`, and `removed`. Binary and untracked
counts can be `null`; totals count known lines in the returned files. The list
is capped at 200 files, and `truncated` signals an incomplete list or git
output. `live` with an empty list is a clean result; `missing` means the job's
usable worktree record was not found, and `degraded` means the git read was
incomplete or failed. A degraded result may contain partial files.

Exit code 0 means `live`, 1 means `missing`, `degraded`, or an unexpected read
failure, and 2 means invalid arguments or job ID. Usage and unexpected read
failures produce a JSON object with an `error` string instead of the projection.
