# Bets lane and self-awareness loop

Owner rule (RQ-BETS-LANE-1): each cycle a fixed share of free capacity goes to
ambitious experiments ("bets"). Each bet is scored by the leverage it delivers
and killed fast when it does not pay off. The fleet measures its own loop
(throughput, idea-to-merged-to-installed time, cost per merged PR, capacity per
node) and feeds the numbers to routing as advisory hints.

All files live under `$ASHLR_RUNS_DIR` or `~/.ashlr-runs`.

## Commands

| Command | Effect |
| --- | --- |
| `phm metrics loop [--since 24h] [--dry-run] [--json]` | Print where the loop waits (`stages`, schema `metrics.loop-stages.v1`), then collect the loop report and write the loop, hint and share files; merge morning fields. `--dry-run` writes nothing. The desktop Metrics card serves the same report from `GET /api/verse/fleet/runs/metrics?since=24h|7d` (`loopStages`), reading releases through the same reader and keeping them for 10 minutes; when releases cannot be read, `releases` is `unavailable` and `releases_reason` says why; `jobs_truncated` is true when the jobs ledger tail was cut at the read cap, and the loop report's `truncated_sources` names every bounded ledger tail that was cut. |
| `phm bets list [--json]` | Current state of every bet (fold of the ledger). |
| `phm bets launch --id RQ-BET-<slug> --hypothesis <text> --metric <key> --max-lane-hours <n> --max-cycles <n>` | Append a launch. Baseline defaults to the metric's value in today's loop file, or unknown. |
| `phm bets score [--dry-run] [--json]` | One kill-fast cycle over every launched bet; appends each decision with its numbers and refreshes `bets-share.json`. |
| `phm bets kill <id> --reason <text>` | Operator kill, appended to the ledger. |
| `phm bets suggest [--json] [--limit N]` | Rank the next jobs worth queuing (default 10, at most 50). Read-only: it never queues anything. |
| `phm bets explain <id> [--json]` | One suggestion's inputs and each term of its score. Exit 1 when the id is not on the current list. |

## Suggested next jobs

`phm bets suggest` does the leader's hourly pick as one typed, read-only step (`fleet.next-bets.v1`,
`src/core/fleet/next-bets.ts`). It reads lane status (`phm lanes --json`), usage pace (`use_it_all`),
launch yield (`phm fleet yield`), main health, the Ops releases probe (local git only) and
`phm autonomy`; a source that cannot be read is `unknown` under `signals` and adds no suggestion.
Each suggestion has a goal, lane, tier, repo, the signal with its numbers, a score and a `queueLine`
to paste into the router queue. The Ideas view shows the top 5 with "Copy queue line"
(`GET /api/verse/fleet/control/ideas/bets`).

Score is the sum of `min(value, cap) x weight` over these terms; ties sort by id.

| Term | Value | Weight | Cap |
| --- | --- | --- | --- |
| `redMain` | 1 for a red main branch (always ranks first) | 1000 | 1 |
| `fixAttempt` | guardian fix attempts that did not clear it | 10 | 10 |
| `idleSlot` | free slots on a lane with nothing queued and no hold, counted against the launch target (configured target tightened by the controller's `effective_target` shed) | 40 | 5 |
| `poolWastePct` | percent of usage projected to expire unused (from 20 up) | 2 | 100 |
| `releaseAgeDay` | days since the last tag, when commits follow it | 4 | 30 |
| `unreleasedCommit` | commits since the last tag | 1 | 40 |
| `noRecentRelease` | 1 when the autonomy report counted no release | 20 | 1 |
| `familyEmptyRate` | empty share of the job family (5+ launches in 24 h); a penalty | -100 | 1 |

Lane and pool suggestions join the `leader` job family; a red main joins the family of its
guardian fix jobs. Lane suggestions take the tier with the best merged-per-launch yield.

## Files

| File | Schema | Writer | Notes |
| --- | --- | --- | --- |
| `metrics/bets.jsonl` | `bets.ledger.v1` | `phm bets` | Append-only events: `launch`, `score`, `kill`. Events after a terminal state are ignored. |
| `metrics/bets-share.json` | `bets.share.v1` | `phm metrics loop`, `phm bets score` | `reserved` and `usable` bet slots this cycle, stamped `at`. |
| `metrics/loop-YYYYMMDD.json` | `metrics.loop.v1` | `phm metrics loop` | Full report. Unknown values are `{"missing": "<reason>"}`. `truncated_sources` names ledger files whose bounded tail read was cut; counts folded from them cover only the newest bytes. |
| `metrics/selection-hints.json` | `metrics.selection-hints.v1` | `phm metrics loop` | Advisory: ranked lanes, nodes with spare slots, top constraint, and `loop_wait` — the where-the-loop-waits summary (headline, slowest stage, window, truncation flag) folded from the same jobs.jsonl tail as `metrics.loop-stages.v1`. |
| `reports/morning-YYYYMMDD.json` | (existing) | `phm metrics loop` | Adds `bets`, `feedback_loop_minutes`, `cost_per_merged_pr`, `capacity_per_node`; other keys are kept. A file that is not a JSON object is left untouched. |

## Bet rows and the capacity share

A ready row is a bet when its id starts with `RQ-BET-` or its tier starts with
`bet:`. `betsShare` reserves `floor(free * share)` slots (default share 0.1),
at least one whenever any slot is free, never more than free. Unknown free
slots reserve nothing. `usable` is `min(reserved, ready bet rows)`.

dispatchd is pinned and does not read `bets-share.json` yet. The change that
lets it (promote up to `usable` `RQ-BET-` candidates behind any leading
`RQ-FIX-MAIN-` rows; a missing, stale, malformed or disabled file changes
nothing) ships only as a Security package, never by editing the pinned file.
dispatchd's tier check accepts only known tiers, so until that list admits a
`bet:` tier, only the id prefix is honoured at launch.

## Kill-fast scoring

A bet's jobs are every jobs-ledger id that starts with the bet id. Per cycle:

1. `kept` when at least one bet job merged and the metric moved by more than `minDelta` in the bet's direction.
2. `killed` when the budget (lane-hours or cycles) is exhausted and the metric did not move.
3. `killed` when the budget is exhausted and the metric moved but nothing merged.
4. `hold` otherwise.

An unknown metric value or baseline never counts as moved. Every decision row
carries value, baseline, delta, lane-hours, merged and job counts, and budget.

Metric keys: `merges_per_hour.1h`, `merges_per_hour.6h`, `opens_per_hour.1h`,
`opens_per_hour.6h`, `idea_to_merged_minutes.p50`,
`merged_to_installed_minutes.p50`, `feedback_loop_minutes.p50`,
`cost_per_merged_pr`, `spare_slots`.

## Sources and definitions

- Throughput: `metrics/jobs.jsonl` MERGED outcomes and first PR publish per job over 1h and 6h.
- Idea to merged: the `enqueue` row dispatchd writes when it first sees a `queue/ready.tsv` row, to the MERGED outcome. ready.tsv itself has no timestamp column.
- Ledger rows are read in the fleet's canonical jobs.jsonl dialect — job ids `job|job_id|jobId|id`, event names `event|type|kind` (`published` normalizes to `publish`), phases `state|outcome|status` (an eventless PUBLISHED/MERGED/CLOSED/OPEN row infers its event), timestamps `ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt`, PR links `url|pr_url|prUrl|pr|html_url` and the `pool` lane alias — the same field sets `queue/visit-sync`, `queue/job-outcomes`, `fleet/agent-activity`, `fleet/job-latency`, `fleet/throughput` and `metrics/reward-feed` accept, so reconciler-resolved merges count once.
- Merged to installed: `gh` merged PRs and releases for ashlrai/phantom plus `/Applications/Phantom.app/Contents/Info.plist` (version and file time). Only merges first shipped by the installed release are timed.
- Feedback loop: enqueue to install, for jobs whose PR is in the installed release.
- Cost per merged PR: the newest `costPerMergedPrUsd` in `metrics/growth-cost-hourly.jsonl` within 24h.
- Lanes: every lane in `queue/slots.json` (direct or `lanes`-wrapped), plus any lane seen in the ledger; merged per lane-hour over 6h.
- Capacity: the local dispatcher (slots cap, adaptive cap from `queue/concurrency.json`, running from `queue/status.json`) and every node in the node inventory and declared profiles.
- Dot and Instinct: the iMessage teammate task store.
