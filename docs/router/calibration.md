# Router calibration

`phm router-calibration --jobs jobs.jsonl [--posthog runs.json] [--json]` reads local files and prints Markdown by default or JSON with `--json`. It makes no network requests. Each JSONL record has `event` (or `type`) and `job_id` (also `jobId` or `id`). Recognized events are `launch`, `finish`, `publish`, and `outcome`. There must be exactly one launch per job ID; its `arm` identifies the routing arm. A job ID identifies one attempt, including retries. Unrecognized events are ignored, but a nonempty ledger with no recognized events is rejected.

Use numeric `predicted_merge_rate` (probability from 0 to 1), `predicted_tokens`, and `predicted_wall_time_ms` for predictions. Actual usage is `tokens` or `total_tokens` and `wall_time_ms` or `duration_ms`. Camel-case equivalents are accepted. A finish and launch with ISO timestamp fields `timestamp`, `at`, or `time` supply wall time if it is otherwise absent. An outcome of `merged` is positive; `closed`, `rejected`, `failed`, or `not_merged` is negative. A boolean `merged` is also accepted. Publishing, unknown outcomes and missing outcomes are not evidence of a merge or failure.

The optional PostHog export is a JSON array or an object with a `results` array; each row is a run or has a `properties` object. Join by `job_id` or `jobId`, using the same numeric fields. Unmatched rows are counted. Conflicting values and duplicate launches are rejected rather than silently double-counted. PostHog export input must represent one run per job or contain consistent duplicate observations.

Calibration also accepts dispatcher records with `job` as the job ID and
`lane` or `pool` as the launch arm. It reads `tokens_total` and converts a
finish row's `wall_s` to milliseconds when that row has no millisecond
measurement. Launch and finish `ts` stamps provide the elapsed-time fallback.
Eventless `MERGED` or `CLOSED` verdicts and those carried on reconciler publish
rows resolve the job. An ordinary publish claim alone leaves it unresolved.
Batch session wrappers and node-pool telemetry are excluded. Supply records
with one launch per included job or a matching reward signal.

The jobs input also accepts reward-signal rows. Each supplies the resolved
merge outcome and any recorded pool and joins launch or PostHog evidence by
job ID. Execution wall time uses explicit measurements or the launch and
finish timestamps. Reward timestamps describe dispatch and PR resolution,
and `ciWallMs` measures CI, so a reward row alone leaves execution wall time
unknown.

Each predicted / actual average uses only jobs with both values, with the paired count shown alongside it. Brier is the mean squared difference between each recorded merge probability and its binary resolved outcome for that same population. `resolved` counts all known outcomes, including jobs without predictions. Missing pairs produce null in JSON and `n/a` in Markdown. These are descriptive statistics of recorded evidence, not proof that the sample is representative. The files supplied by the operator determine schema compatibility and coverage.
