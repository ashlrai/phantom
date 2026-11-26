# Router calibration

`phm router-calibration --jobs jobs.jsonl [--posthog runs.json] [--json]` reads local files and prints Markdown by default or JSON with `--json`. It makes no network requests. Each JSONL record has `event` (or `type`) and `job_id` (also `jobId` or `id`). A standalone launch's `arm` identifies the routing arm. A job ID identifies one attempt, including retries. Unrecognized events are ignored, but a nonempty ledger with no recognized events is rejected.

Use numeric `predicted_merge_rate` (probability from 0 to 1), `predicted_tokens`, and `predicted_wall_time_ms` for predictions. Actual usage is `tokens` or `total_tokens` and `wall_time_ms` or `duration_ms`. Camel-case equivalents are accepted. A finish and launch with ISO timestamp fields `timestamp`, `at`, or `time` supply wall time if it is otherwise absent. An outcome of `merged` is positive; `closed`, `rejected`, `failed`, or `not_merged` is negative. A boolean `merged` is also accepted. Publishing, unknown outcomes and missing outcomes are not evidence of a merge or failure.

The optional PostHog export is a JSON array or an object with a `results` array; each row is a run or has a `properties` object. Join by `job_id` or `jobId`, using the same numeric fields. Unmatched rows are counted. PostHog export input must represent one run per job or contain consistent duplicate observations.

Calibration counts identical launch receipts with a valid timestamp once, even
when replayed after a finish or verdict. It rejects conflicting values and
other duplicate launches, including identical launches without timestamps.

Calibration also accepts dispatcher records with `job` as the job ID and
`lane` or `pool` as the launch arm. It reads `tokens_total` and converts a
finish row's `wall_s` to milliseconds when that row has no millisecond
measurement. Launch and finish `ts` stamps provide the elapsed-time fallback.
Eventless `MERGED` or `CLOSED` verdicts and those carried on reconciler publish
rows resolve the job. An ordinary publish claim alone leaves it unresolved.
Supply a launch, a `batch_claim`, or a reward signal for each included job.
A batch member's recorded claim lane supplies the arm only for jobs with no
standalone launch and no recorded reward pool. An unlabeled standalone
launch uses the `unknown` arm unless a reward signal supplies its pool.
Arm lookup skips blank values and
case-insensitive `unknown` placeholders, so a later alias or a recorded
reward pool can supply the arm. Jobs with no usable arm and jobs with
conflicting claim lanes alone use the `unknown` arm. Conflicting known
launch and reward arms still cause an error. Claim timestamps provide no execution timing. Batch
session wrappers and node-pool telemetry are excluded. Lifecycle receipts
explicitly marked `launched: false`, such as admission-time `DONE-NOOP`
outcomes, contribute no jobs, verdicts or measurements. A ledger containing
only these recognized receipts yields an empty calibration sample.

The jobs input also accepts reward-signal rows. Each supplies the resolved
merge outcome and any recorded pool and joins launch or PostHog evidence by
job ID. When both ledgers supply a verdict for the same job, calibration
uses the reward verdict regardless of row order. This lets a recorded
revert count against a historical merge. Conflicting verdicts within either
source still cause an error. Execution wall time uses explicit measurements or the launch and
finish timestamps. Reward timestamps describe dispatch and PR resolution,
and `ciWallMs` measures CI, so a reward row alone leaves execution wall time
unknown.

The reward feed attributes a resolved job to the latest dispatch timestamp
at or before its outcome bound. Conflicting pool receipts at that timestamp
leave the reward's pool null. A single observed pool is retained when other
receipts at that timestamp carry missing or unknown pool labels.
The feed leaves CI wall time unknown when a batch claim falls at or between
the paired CI timestamps. A batch claim strictly before CI starts can still
supply dispatch evidence for a reward with measured CI wall time.

Each predicted / actual average uses only jobs with both values, with the paired count shown alongside it. Brier is the mean squared difference between each recorded merge probability and its binary resolved outcome for that same population. `resolved` counts all known outcomes, including jobs without predictions. Missing pairs produce null in JSON and `n/a` in Markdown. These are descriptive statistics of recorded evidence, not proof that the sample is representative. The files supplied by the operator determine schema compatibility and coverage.

Observed merge rate (`observedMergeRate` in JSON) divides positive outcomes
by all resolved jobs in the arm, including reward-only jobs. With zero resolved
jobs the rate is null in JSON and `n/a` in Markdown. When `--baseline-jobs` is
provided, the delta subtracts the baseline's observed rate from the current
rate and is available only when both rates are known.
