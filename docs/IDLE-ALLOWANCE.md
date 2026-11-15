# Idle allowance

`phm metrics idle --status status.json --jobs jobs.jsonl --json` reads local files and reports idle slot-minutes per lane and running jobs exceeding twice their lane's median completed wall time. Repeat `--status` for separate snapshots, or supply a JSON array of snapshots in one file. At least two distinct timestamps are required.

Each snapshot has a UTC `timestamp` and a `lanes` array with `lane`, nonnegative integer `running` and `target`, and optional `pausedReason`. Each jobs JSONL row has `id`, `lane`, `status`, and UTC `startedAt`; finished jobs also have `finishedAt`. Use `running` for active jobs. The final snapshot timestamp is the evaluation time. Only completed durations ending by that time contribute to the median. Lanes without completed durations cannot identify stuck jobs.

Each snapshot's capacity deficit, clamped at zero, applies until the next snapshot. A missing lane is not inferred to exist during that interval. The final observation is a boundary and is not extrapolated. Paused slot-minutes are included in idle totals and grouped by reason. These estimates depend on snapshot coverage and do not establish why a slot was idle.
