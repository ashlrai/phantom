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

Use actual observed timestamps. Eligible means the observer saw the PR satisfy its merge requirements; this command does not determine eligibility. Blocker reasons are `required_checks`, `review`, `conflict`, `queue`, or `other`. The report retains blocker timestamps and measures eligibility-to-merge even when readiness precedes enqueue or enqueue is missing. Each measured boundary must be unique and ordered; reblocking, conflicts, closure or observed head changes after readiness make that episode unknown. Missing or ambiguous evidence stays unknown. Recording an observation never changes the queue or bypasses required checks. The JSON report is the agent interface; omit `--json` for plain words.

The ledger is populated automatically: each real `node scripts/merge-queue-loop.mjs cycle` pass appends the merge-queue state transitions it sampled for fleet PRs (see [QUEUE.md](QUEUE.md#merge-queue-throughput-loop)) — `eligible`, `queued` and `checks_passed` at most once per PR, `conflict` once per head, `blocked` on dominant-reason change, `check_observed` on check-rollup change, and `auto_merge_enabled`/`auto_merge_disabled` on observed auto-merge toggles. Every row's `at` is the cycle's observation instant, a sample rather than an exact GitHub transition time; `--record` remains for manual or backfill rows, and `--no-events`/`--events` control the cycle's sink. A dry run records nothing.

Each `queue_timelines` row splits readiness-to-merge into `ready_to_queue_s`
and `ready_in_queue_s` when enqueue is unique and no later than merge.
Already queued PRs have zero admission wait. `dominant_delay` is
`queue_admission` or `queue_execution` for the larger span, otherwise null.
Missing enqueue still permits total readiness-to-merge measurement; it cannot
establish the dominant delay. Queue execution includes any merge-group checks;
these spans identify where time passed, not the cause between observations.

Each row also has typed `status`: `stage`, `since`, `waiting_s`, and `delays_s`
for queue, required checks and conflicts. These sum observed stage intervals,
not unobserved lifetime delays; absent or ambiguous evidence is `null`.
Simultaneous contradictory stages stay unknown. Queue entry and individual
check successes cannot clear a blocker; `checks_passed` clears only checks.
`eligible_to_merge_s` is completed readiness-to-merge time; `ready_wait_s` is
open readiness age. Terminal PRs have no current wait, and measured intervals
stop at merge or closure. The same report reaches the read-only desktop API at
`/api/verse/fleet/merge-latency`. Required checks and sanctioned merge paths stay in place.

The existing [merge queue loop](QUEUE.md#merge-queue-throughput-loop) repairs
green, mergeable fleet PRs with auto-merge armed but no actual queue membership.
It uses the normal head-pinned enqueue request, with the same holds, file gates
and retry caps. Required checks, reviews and merge queue rules still apply.

For each PR, `pr_stages` reports seconds from `opened` to `queued` (queue wait), `queued` to `checks_passed` (required checks), and `checks_passed` to `merged` (merge). The checks interval is elapsed time between observations, not a sum of check runtimes; record `checks_passed` only when all required checks are known to have passed. Missing or repeated boundaries are listed in `missing_or_ambiguous`; reversed timestamps set `out_of_order`. A duration with invalid boundaries is null, and `slowest_stage` is null unless all three durations are known, ordered and have a unique maximum. Open PRs and merges with unknown times remain visible; dated merges outside the selected window are excluded.

Each `pr_stages` row also carries a typed `wait` object: `state` (`not_queued`,
`queued`, `required_checks`, `conflict`, `review`, `blocked`, `merged`, `closed` or
`unknown`), `stage_times` (`opened_at`, `queued_at`, `checks_passed_at`, `merged_at`),
`elapsed_s` (opened to merge, or to now while open), `stage_waiting_s`, `stalled`
(true once the current stage passes `--stalled-after`), a plain-words `diagnosis`, and
`next` (`action`, `automatic`, `note`) naming what happens on its own: the merge queue
merges, required checks run, the recut loop acts, or `merge_retry` re-arms a dropped
auto-merge. A missing, repeated or reversed timestamp makes that value null, never a
guess. It is advice only: required checks, reviews and merge-queue rules stay in force.

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

`queue_state_time` rolls the same spans up across all timelines: per-PR median,
90th percentile and slowest seconds queued before eligibility, eligible before
merge, still queued now, and blocked on each reason. An unmeasurable span counts
`missing`, never zero; in a measurable breakdown an absent reason is a measured
zero. The plain report summarizes it in one `Time in each queue state` line.

Start with `oldest_actionable_delay` in the JSON report, or the `Oldest actionable
queue delay` line in plain output. It identifies one open PR, its enqueue time,
seconds queued, blocker, typed `next_action` and plain recommendation. It considers
all ages, with ties ordered by repo then PR number. Recorded checks, conflicts,
review or other blockers need attention immediately; waits on the queue itself
need attention at `--stalled-after`.
Terminal PRs, missing or repeated enqueue times, and contradictory simultaneous
states cannot become the recommendation. A single check success never clears
other required checks; aggregate readiness can clear the blocker. Null means no
actionable measured entry (check `known` for an unreadable ledger). Advice never
rearms a retry or bypasses required checks, reviews or merge-queue rules.

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
`needs-person` rows carry the classifier reason. Every row has a plain-words
`note`, and the report adds `queue_wait` (`waiting`, `oldest_s`, `total_s`,
`conflicts`, `finished`): how long dropped PRs have waited, with a conflict
marked as needing a recut and an already merged or closed PR counted as
`finished`, not waiting. `retry_requested` is also a
`--record` type so another writer can share the same bound.

Before arming, `merge-retry` lists the repo's open PRs once per run and skips a
candidate that shares a file with another armed, non-draft PR
(`predicted-conflict`): the armed PR lands first, so this arm would be dropped
again and burn a retry. The skip records nothing and spends no retry. This is
file-overlap prediction, not a measured Git conflict; a failed listing, a PR
missing from it, or a file list at the 100-file `gh` cap stays unknown and
still arms.

A failed submission appends one `retry_failed` event instead — transient
failures retry on a later run without spending a retry, while three distinct
failed submissions mark the drop `request-failed` and stop automatic retries
for good. A failed state read records nothing: it was never a submission
attempt and retries for free. `retry_failed` lines dedupe like retries — a
replayed line counts once — and `retry_failed` is a `--record` type too.
