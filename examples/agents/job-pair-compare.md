# Compare artifact facts from two fleet jobs

From the repository root, compare detail and changes for two fleet jobs
(before/after) and, optionally, their worker notes:

```sh
npx tsx examples/agents/job-pair-compare.ts --before fake-job-1 --after fake-job-2 --with-notes
```

`--before` and `--after` are required; `--with-notes` is optional (no-op
when absent). No other flags exist beyond `--help`.

The single JSON object on stdout has `schema`
(`fleet.job-pair-compare.v1`), `before` (detail + changes with `job`,
`lane`, `model`, `artifactState`, `testLine`, `prUrl`, `sources`,
`changes` fields including `observedTotals`), `after` (identical shape),
and `changedFiles` (`{complete, added, removed, common}`). When
`--with-notes` is supplied, an additional `notes` object appears with
`{before, after, complete, added, removed, addedOmitted, removedOmitted}`.
Errors emit `{schema:"fleet.job-pair-compare.error.v1","error":"invalid_arguments"|"reader_unavailable"}` on stderr with exit code `1` (reader unavailable) or `2` (invalid arguments); a successful comparison exits `0`.
