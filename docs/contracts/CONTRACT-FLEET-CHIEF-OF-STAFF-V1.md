# Fleet chief-of-staff plan and brief v1

`fleet.chief-of-staff.v1` is deterministic advice above the mechanical dispatcher.
It grants no authority. It cannot merge, dispatch, resolve credentials, clear holds,
send the brief or spend. There is no apply flag. [Core signatures](../../CONTRACT.md#fleet-chief-of-staff-v1)
are implemented in [chief-of-staff.ts](../../src/core/fleet/chief-of-staff.ts).

## Snapshot

`FleetSnapshot` contains `at` (ISO timestamp with timezone), `lanes`, `jobs` and
`outcomes`. There is no ambient clock or I/O in the core. Counts are integers
0–1,000,000; rates are 0–1. Missing measurements use explicit `null`.

| Array | Fields | Maximum |
| --- | --- | --- |
| lanes | lane, held, target, ceiling, queueDepth, running, errorRate, emptyRate, openPrConflicts, quota | 64 |
| jobs | id, lane, status (`ready`, `running`, `parked`), priority (0–100), queuedAt, startedAt | 200 |
| outcomes | job, lane, at, phase (`finish`, `publish`), result (`success`, `failed`, `empty`), optional empty boolean | 1,000 |

Lane IDs are 1–40 ASCII letters/digits/underscore/hyphen, starting with an
alphanumeric; job IDs allow 64 characters. IDs must be unique in their respective
arrays, and each job must name a captured lane. `held`, all lane measurements,
job timestamps and `quota` accept null. A quota contains `remainingFraction`
and `resetAt`; an elapsed reset is unknown, never replenished quota. Recommended
targets cannot exceed ceiling. Unknown fields are discarded. Invalid or oversized
snapshots throw a fixed error without echoing values, before array traversal.

## Plan and brief

The plan contains `schema`, canonical UTC `at`, and literal `authority`:
`{mode:"recommend-only", allowed:["reorder","inject","retire","brief"],
merge:false, credentials:false, bypassLaneHolds:false}`.

| Field | Entry shape and interpretation |
| --- | --- |
| ordering | job, lane, score, rationale; eligible ready jobs in proposed order |
| laneTargets | lane, current, recommended, reason; null means unknown |
| inject | job, lane, purpose: repair-lane, resolve-conflicts or replenish-queue |
| retire | job, lane, reason: already-published; queue retirement only |
| stuck | job, lane, reason: queue-wait, run-overdue or proof-missing; ageMinutes |
| evidence | recentFinishes, recentPublishes, unknownLanes; observed events, not successful merges |
| brief | format: markdown, text: bounded Markdown, at most 12,000 characters |

Ordering score is priority × 10 + capped age in hours (24) + 20 for a reset
within an hour − 50 for poor health − min(50, conflicts × 10). Ties preserve
snapshot queue order. Poor health means error rate ≥ .25 or empty rate ≥ .5.
Targets halve (rounded up) on poor health; otherwise remain within demand and
ceiling. An increase of at most one requires complete evidence, no conflicts,
a reset within an hour and remaining quota > .25. Incomplete evidence never
increases a target. Replenishment requires a measured empty queue and complete,
healthy evidence. Diagnostic job IDs are stable; existing or recently attempted
IDs suppress another injection.

Held, unknown-hold, disabled and exhausted/unknown-quota lanes receive no job
recommendations. Expired holds are never cleared by this planner. Parked jobs
are excluded. Ready jobs waiting six hours and running jobs older than two hours
are flagged; successful finishes lacking publication after one hour flag missing
proof. Retirement requires the latest publication evidence to agree on success
since the known queue-entry/start time. Undated jobs cannot be retired. Outcomes older than 24 hours
or in the future are ignored, and identical events are deduplicated.

Every output string is a validated identifier, canonical date or generated text;
prompt content, paths and arbitrary reasons never enter the brief. Arrays are
bounded by the snapshot: 200 ordered/retired jobs, 64 lane targets/injections,
400 stuck observations. Markdown shows 10 entries per work/attention list.

## CLI capture

```sh
npm run dev -- fleet chief-of-staff --snapshot snapshot.json --json
npm run dev -- fleet chief-of-staff --snapshot auto --brief
```

Auto (the default) reads below `ASHLR_RUNS_DIR`, otherwise `~/.ashlr-runs`:
`queue/{ready.tsv,slots.json,resources.json,status.json}`, `metrics/jobs.jsonl`,
and `fleet/open-prs.json`. Roots, reader, clock and output sinks are injectable.
Reads are capped at 1 MiB; only the metrics ledger uses a tail. No prompt files
are opened. Ready columns are id/repo/lane/tier/prompt; parked rows are ignored.
Missing enqueue/start times stay null and priority defaults to 50.

Slots/resources accept direct maps or a `lanes` wrapper. Slots supply target,
ceiling, hard_cap and held; resources supply used_frac and reset_at (ISO or epoch
seconds). Fresh status (last_tick within 60 seconds) supplies running and
effective holds, including global paused. A stored hold always wins. The latest
1,000 ledger rows supply finish/publish evidence and sampled health rates;
successful publication requires an explicit success result or a recorded GitHub
PR URL. No URL is emitted. Open PRs must be a complete array with an explicit
lane and mergeable (`MERGEABLE`/`CONFLICTING`); unassigned/unknown PR evidence
leaves conflict counts null. Ordinary gh captures lacking lane attribution are
reported as degraded, not zero conflicts. Offline snapshots support richer
joined evidence, running jobs and measured queue ages.

JSON adds `sources`, keyed only by these relative filenames, with healthy,
bounded (metrics sample), unavailable or degraded states. Brief output appends
the same source states. Exit 0 means a plan was produced, 1 means partial or
invalid evidence, and 2 means usage error. Partial auto plans remain visible;
an invalid explicit snapshot emits only a fixed error. Source success never
authorizes execution; any consumer must refresh holds, quotas and work claims.
