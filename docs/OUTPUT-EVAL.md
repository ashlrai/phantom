# Agent output evaluation

`phm fleet output-eval record --json` rebuilds a private derived snapshot from
`~/.ashlr-runs/metrics/jobs.jsonl`. `phm fleet output-eval report --json` reads
it for routing analysis. Use `--jobs <file>` on record and `--store <file>` on
both commands to select paths. Record replaces the snapshot, so retain the source
ledger when a historical view is needed. The snapshot contains only job, lane,
model and outcome; it has no prompts, diffs, provider payloads or timestamps.

Launch rows supply lane and model. A merged outcome, an `abort_*` class or
aborted outcome, and an empty finish supply terminal evidence. Duplicate
observations are counted once; missing attribution, unresolved jobs, conflicting
launch attribution or conflicting terminal evidence are excluded and counted in
`excluded`. IDs must identify individual attempts: indistinguishable repeated
launches cannot be separated. Missing model is never guessed. Secret-shaped or
invalid identifiers are rejected. The file is written with mode 0600 in a 0700
new directory, using an atomic replacement.

The versioned report groups by lane and also by lane and model, and gives each outcome count,
`total`, and `mergeRate` (merged divided by the three recorded terminal outcomes).
It is evidence for routing decisions, not an automatic routing change or proof
of causality. Unresolved jobs and outcomes outside these categories are absent;
compare sample counts and account for task mix and selection bias before using
rates. A missing, unreadable or invalid store fails instead of reporting zero.
