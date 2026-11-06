# Batch artifact status for fleet jobs

From the repository root, read fleet.job.v1 details for multiple jobs, ordered
by first occurrence of each repeated ID, with at most four parallel reads:

```sh
npx tsx examples/agents/job-batch-status.ts --job fake-job-1 --job fake-job-2
```

`--job` is required and may be repeated 1–20 times; duplicate IDs are read
once in first-given order. No optional flags exist beyond `--help`.

The single JSON object on stdout has `schema` (`fleet.job-batch-status.v1`),
`generatedAt` (ISO timestamp), `complete` (boolean), and `jobs` — an array
with one `JobStatus` per requested ID: `job` (string), `state` (detail state
or `"unavailable"`), `lane` (string or null), `model` (string or null),
`publish` (`null` or `{prUrl, testLine}`), `logSource`, and `sources`. Errors
emit `{"schema":"fleet.job-batch-status.error.v1","error":"invalid_arguments"|"reader_unavailable"}` on stderr with exit code `1` (read failure, at least one job unavailable) or `2` (invalid arguments); a fully successful read exits `0`.
