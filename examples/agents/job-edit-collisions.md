# Compare changed paths across fleet jobs for collisions

From the repository root, read fleet.job.v1 changes for two or more distinct
fleet jobs and compute the set of paths changed by more than one:

```sh
npx tsx examples/agents/job-edit-collisions.ts --job fake-job-1 --job fake-job-2 --job fake-job-3
```

`--job` is required and must be supplied 2–20 times with all IDs distinct.
No optional flags exist beyond `--help`.

The single JSON object on stdout has `schema`
(`fleet.job-edit-collisions.v1`), `generatedAt` (ISO timestamp), `complete`
(boolean), `sources` (one per job: `{job, generatedAt, state, truncated}`),
and `intersections` (paths with `jobs: [...]` shared across owners, sorted).
An empty `intersections` means no observed collisions. Errors emit
`{"schema":"fleet.job-edit-collisions.error.v1","error":"invalid_arguments"}` on stderr with exit code `1` (partial report) or `2` (invalid arguments); a complete report exits `0`.
