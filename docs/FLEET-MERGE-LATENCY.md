# Merge queue latency

Record observed transitions in a local JSONL ledger, then read the report:

```sh
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"opened","at":"2026-11-01T11:59:00Z"}'
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"queued","at":"2026-11-01T12:00:00Z"}'
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"blocked","at":"2026-11-01T12:01:00Z","reason":"required_checks"}'
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"eligible","at":"2026-11-01T12:05:00Z"}'
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"checks_passed","at":"2026-11-01T12:05:00Z"}'
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"merged","at":"2026-11-01T12:06:00Z"}'
phm fleet merge-latency --events merge-events.jsonl --json
```

Use actual observed timestamps. Eligible means the observer saw the PR satisfy its merge requirements; this command does not determine eligibility. Blocker reasons are `required_checks`, `review`, `conflict`, `queue`, or `other`. The report retains blocker timestamps and gives enqueue-to-eligibility and eligibility-to-merge durations only when each boundary is unique, ordered, and no blocker was recorded after eligibility. Missing or ambiguous evidence stays unknown. The ledger is not populated automatically, and recording an observation never changes the queue or bypasses required checks. The JSON report is the agent interface; omit `--json` for plain words.

For each PR, `pr_stages` reports seconds from `opened` to `queued` (queue wait), `queued` to `checks_passed` (required checks), and `checks_passed` to `merged` (merge). The checks interval is elapsed time between observations, not a sum of check runtimes; record `checks_passed` only when all required checks are known to have passed. Missing or repeated boundaries are listed in `missing_or_ambiguous`; reversed timestamps set `out_of_order`. A duration with invalid boundaries is null, and `slowest_stage` is null unless all three durations are known, ordered and have a unique maximum. Open PRs and merges with unknown times remain visible; dated merges outside the selected window are excluded.

To record a check, use the same `--record` command with `type` set to
`check_observed`, `conclusion` to `success`, `failure`, or `pending`, and
`required` to `true` or `false` only when known. Omit `required` when its
status is unknown. The report counts failed observations separately by required
status; these are observations, not unique checks or a current check state.
Missing check observations remain unknown.

`wait_by_reason_s` sums intervals from each `blocked` observation to the next
blocker or eligibility. It is unknown unless a blocker is observed at enqueue,
all transitions are ordered, and eligibility is observed once. An open blocked
PR therefore has an unknown total until eligibility is observed. These durations
are based on observed transitions and do not establish the cause between samples.

## Bounded retry for transient queue failures

An open PR whose recorded auto-merge request was dropped shows under
`queue_retries`. The drop is `retryable` when the last timed transition is
`auto_merge_disabled` after a timed `auto_merge_enabled` and the newest
recorded blocker in that episode is `queue`; every other cause stays with its
owner (a `conflict` blocker belongs to the recut path) and a drop with no
queue blocker is `unattributed` for a person to judge. Each PR gets at most
three distinct `retry_requested` events ever — identical replayed lines count
once — and a retry recorded at or after the drop marks the episode
`already-requested`. These are observations, not merge authority.

`phm fleet merge-retry [--events file] [--apply] [--json]` turns `retryable`
rows into action: dry-run prints `request-auto-merge`, and `--apply` re-arms
ordinary head-pinned GitHub auto-merge (`gh pr merge --auto
--match-head-commit`), records one `retry_requested` event, and caps each run
at three requests. Required checks, reviews and the merge queue remain
enforced; the PR merges only when they pass on their own. Rows report
`already-armed`, `conflict`, `draft`, `held`, `capped` or `failed`, and
`needs-person` rows carry the classifier reason. `retry_requested` is also a
`--record` type so another writer can share the same bound.
