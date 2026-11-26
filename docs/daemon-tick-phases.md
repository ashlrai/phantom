# Daemon tick phases

Every awaited stage of a resident daemon tick now runs inside a bounded
**phase**. A phase has a deadline, an `AbortSignal`, exception capture, a
degrade path and a log line — so one wedged await can never freeze
`lastTickAt` again. This page is the operator reference for reading and
tuning that behavior.

## Read the phases

```sh
phm daemon status --json | jq .tick.phases
```

```json
[
  { "name": "tick hooks", "status": "ok", "durationMs": 412 },
  { "name": "mirror-prep", "status": "ok", "durationMs": 8031 },
  { "name": "backlog-refresh", "status": "ok", "durationMs": 96 },
  { "name": "self-heal", "status": "ok", "durationMs": 210 },
  { "name": "invent", "status": "skipped", "error": "no-frontier", "durationMs": 3 },
  { "name": "capacity", "status": "ok", "durationMs": 87 },
  { "name": "dispatch-plan", "status": "ok", "durationMs": 12 },
  { "name": "dispatch", "status": "timeout", "durationMs": 305004,
    "error": "phase exceeded its 5 min deadline; cancelled and left running detached" }
]
```

`.tick` also carries `lastTickAt`, `outcome` and `lastError`. While a tick is
in flight `tickInProgress` names the phase currently running.

## Phase statuses

| status      | meaning                                                        |
|-------------|----------------------------------------------------------------|
| `ok`        | the stage settled inside its deadline                          |
| `degraded`  | the stage threw or rejected; the tick continued and completed  |
| `timeout`   | the stage exceeded its deadline; cancelled, then left detached |
| `skipped`   | intentionally not run (`error` says why, e.g. `no-frontier`)   |
| `running`   | in-progress snapshot only — never persisted                    |
| `off-tick`  | work handed to a resident background job; the tick did not wait |

For `off-tick`, `durationMs: 0` is handoff metadata, not a work result.
`offTick` carries `state` (`started` or `running`), `run`, `since`, and the
previous settlement's `lastStatus`, `lastDurationMs`, `lastSettledAt` and
`lastError` when available. These entries do not affect the tick outcome.

Resident non-dry-run ticks keep self-heal and ancillary maintenance in-tick.
Self-heal holds the outward mutation fence while verifying repositories, and
its post-heal backlog refresh runs before selection. Ancillary's regression
sentinel also holds that fence across verification and any bisect/revert.
Reflection is a separate single-flight off-tick job in resident ticks; it
writes only learning reports and append-only genome entries and does not take
the outward mutation fence. On the same self-improvement cadence a
`reward-sync` off-tick job folds the jobs-ledger tail into the append-only
reward-signal ledger (`src/core/metrics/reward-feed.ts`), discounting merges
the standing revert set proves did not hold. It takes the lane and dispatch
time from the latest dispatch at or before the outcome, using GitHub's
merge timestamp when available for a held merge. It skips jobs without an
eligible dispatch. The job is best-effort, never throws, and writes only
under `~/.ashlr/metrics`. A `skill-nudge`
off-tick job on the same cadence folds the same tail into candidate shadow
skill cards (`src/core/fleet/skill-nudge.ts`), discounting merges the
standing revert set proves did not hold; it writes only candidate
records under `~/.ashlr/skills`. An `empty-tag-sync` off-tick job on the
same cadence folds the tail's windowed empty finishes into
`metrics/empty-tags.jsonl` and the matching dupcheck outcome rows
(`src/core/fleet/empty-tag-sync.ts`) — the records `phm jobs empty
--record` appends by hand, now automatic; it is best-effort, never throws,
and writes only under the runs dir. A `visit-sync` off-tick job on the
same cadence folds the same jobs-ledger tail plus the live READY rows of
`queue/router-queue.md` into the queue visit journal
(`src/core/queue/visit-sync.ts`) — the records `phm queue visits-sync
--apply` appends by hand, now automatic, so `phm queue stats` and
`/api/queue/stats` stay fed; it is best-effort, never throws, dedups
against the journal and skips the append when the journal is unreadable.
A `swapout-sync` off-tick job runs on every resident tick — outside the
`selfImprove` cadence, since it is host evidence rather than queue work —
and folds the bridge's latest `memstat.json` sample into
`metrics/swapout-rate.jsonl` (`src/core/fleet/swapout-sync.ts`), the tuning
ledger `lane-autopilot.ts`'s MEMORY_GUARD constants name but nothing wrote.
Sample time is the sample's own timestamp, dedup by `sampled_at` keeps
appends at the bridge's cadence, and an unreadable ledger blocks the
append rather than risking a duplicate row; it is best-effort, never
throws, and writes only under the runs dir. `phm fleet vitals` reads the
ledger back into its `swapout_rate` evidence so the distribution the
thresholds should be tuned against is visible; with the lane-autopilot
thresholds injected, each `memoryGuard` share reports how often a
MEMORY_GUARD condition would have fired across the samples carrying that
field — the calibration denominator the constants' tune-from-the-ledger
note asks for, advisory only and never a routing input; unknown stays
unknown.
A job that ignores
cancellation remains single-flight until its work settles; shutdown cancels
running jobs with bounded waiting. Once ticks keep reflection in-tick;
dry-run ticks skip maintenance.
Resident non-dry-run ticks run auto-merge before backlog-refresh; backlog scans
at most four repositories concurrently, aggregating results in repository
input order before existing ranking.

Backlog discovery uses asynchronous, abortable GitHub reads (CI discovery reads
only repository identity and workflow status, not PR or issue counts). Each
scanner has a 45-second sub-deadline. A missed deadline produces no items and an
unavailable `scanner-deadline` observation; phase cancellation records
`phase-cancelled` and prevents new scanners from starting. `skippedScanners` and
the refresh audit summary report these skips.

One scan snapshot is shared by all refreshes within a tick. Proposal repair
invalidates the local queued-autonomy scanner. Post-self-heal refreshes invalidate
that queue and all scanners in `checkedRepos`, including repos with pruned queue
items. Only a missing self-heal result falls back to all enrolled repos. Invent conservatively invalidates
all scanner results because it can change local inputs. Remote GitHub query
promises remain shared for the tick; ranking, filters and persistence always
run again. Fence-bound maintenance remains on-tick.

Tick hooks keep KILL revocation, mirror preparation and enrollment reconciliation
ahead of intake. Leader work overlaps the cloud-intake → Devin sequence, retaining
its 15-second wait limit; intake and Devin retain their 90-/60-second limits.
Ledger, journal and waiting-verification evidence reads overlap, with PR
observations following the ledger. Holds/cooldown writes and post-merge watch
remain serial, outside these groups. Timeouts still audit and continue without
waiting for detached work; these limits do not cancel those producers.

Ancillary observation work shares `ANCILLARY_OBSERVATION_BUDGET_MS` (60 seconds):
counterfactual replay, real-world outcome scanning and rejection learning check
the same deadline and phase cancellation. Exhausted stages audit
`daemon:ancillary-skip` with `ancillary-budget` or `phase-cancelled`. Replay
passes cancellation to its judge and never publishes interrupted calibration.
Outcome windows cap their git deadline to the remaining budget; an interrupted
window does not advance the existing monitoring cursor or arm the six-hour
throttle. Learning stops between items and relies on existing written-lesson
dedup on retry. Interrupted replay persists a pending flag in daemon state to
retry next eligible tick, then returns to its every-20-ticks cadence. Other
eligible work retries next tick. Cancellation is cooperative: synchronous metadata I/O and
an in-progress atomic write must finish, never detach while holding authority.
Credit release, reflection scheduling and regression/bisect/revert are outside
this sub-budget and unchanged; the whole ancillary phase is not a 60-second
hard bound.

## Tick outcomes

`.tick.outcome` folds the phases plus whole-tick failure into one word:

- `ok` — every awaited phase settled clean (off-tick handoffs are excluded).
- `degraded` — at least one phase threw.
- `timeout` — at least one phase hit its deadline, or the whole tick was
  abandoned at the resident deadline.
- `failed` — `tick()` threw before it could produce a record.

`lastTickAt` advances on every outcome — including `failed` and `timeout`.
A frozen `lastTickAt` was the original incident shape: one never-settling
await inside `tick()` kept `recordTick` unreachable forever. `runDaemon` now
wraps each `tick()` call in a 60-minute backstop (`DAEMON_TICK_DEADLINE_MS`)
and persists the outcome in a `finally`, whatever `tick()` did.

## Deadlines

| phase            | default deadline | what bounds it                                          |
|------------------|------------------|---------------------------------------------------------|
| `tick hooks`     | ~26 min          | `boundedBeforeTick` (25 min + grace)                    |
| `mirror-prep`    | prep + abort grace + 30 s | wraps the existing per-repo mirror deadline      |
| `backlog-refresh`| 5 min            | `TICK_PHASE_BACKLOG_REFRESH_MS`                         |
| `self-heal`      | 5 min            | `TICK_PHASE_MAINTENANCE_MS`; 2 min cycle budget, 2 min per repo |
| `invent`         | 3 min            | `TICK_PHASE_INVENT_MS`; frontier probe ≤30 s            |
| `ancillary`      | 5 min            | `TICK_PHASE_MAINTENANCE_MS`                             |
| `reflection`     | 3 min            | `TICK_PHASE_REFLECTION_MS`; separate resident off-tick job |
| `reward-sync`    | 1 min            | `TICK_PHASE_REWARD_SYNC_MS`; resident off-tick reward-ledger feed |
| `skill-nudge`    | 1 min            | `TICK_PHASE_SKILL_NUDGE_MS`; resident off-tick shadow skill-card feed |
| `empty-tag-sync` | 1 min            | `TICK_PHASE_EMPTY_TAG_SYNC_MS`; resident off-tick empty-tag/dupcheck evidence feed |
| `visit-sync`     | 1 min            | `TICK_PHASE_VISIT_SYNC_MS`; resident off-tick queue-visit journal feed |
| `swapout-sync`   | 1 min            | `TICK_PHASE_SWAPOUT_SYNC_MS`; resident off-tick memstat → swapout-rate ledger feed |
| `ci-rerun`       | 5 min            | `TICK_PHASE_CI_RERUN_MS`; optional resident off-tick flake maintenance |
| `auto-merge`, `proposal-repair` | 5 min | `TICK_PHASE_MAINTENANCE_MS`                   |
| `capacity`       | 30 s             | `TICK_PHASE_CAPACITY_MS`; internally probed             |
| `node-bridge`    | 30 s             | `TICK_PHASE_NODE_BRIDGE_MS`; resident single-flight background job, no abort grace |
| `dispatch-plan`  | 60 s             | `TICK_PHASE_DISPATCH_PLAN_MS`                           |
| `dispatch`       | worst-case turns | `tasks / slots` × (turn watchdog + grace)               |
| `dispatch-hook`  | 60 s             | per-item `afterDispatch` hooks                          |

All phases of one tick also share a whole-tick budget, `TICK_BUDGET_MS`
(12 min, under the 15 min admission staleness bound). A phase that starts
inside the budget gets at most what is left of it. A phase that starts after
it is skipped and recorded as `skipped: tick-budget-exhausted`; the next tick
picks the work up. `dispatch` and `dispatch-hook` are exempt, because their
runs are already admitted. When a `backlog-refresh` times out, the scan keeps
running detached, so later refreshes in the same tick are skipped rather than
stacked on top of it. The 60-minute `DAEMON_TICK_DEADLINE_MS` remains the
backstop for an await that is not a phase.

The `node-bridge` entry in `phm daemon status --json | jq .tick.phases`
includes `bridgeTiming` when the current daemon has a timing receipt. It
contains `startedAt`, `endedAt` (null until the bridge ends or handles
cancellation), and up to 32 recent `steps` of
`{step, startedAt, ms, outcome}`. Outcomes are `ok`, `error`, or
`in-flight`. Lock acquisition and release, synchronous router calls, and
queue reads are timed separately. An interrupted pass retains completed
steps and the step it was waiting on. For an unfinished step, `ms` is
elapsed time at cancellation or, if cancellation was not observed by the
child, elapsed time at the status read. Receipts are written separately by
the bridge child, so reading them does not require another daemon tick.

`~/.ashlr/daemon-tick-progress.json` always says `"authority": "none"`. That
marks the file as observational, meaning it grants nothing. It is not the
standing grant; read that with `phm authority status`.

At a deadline the phase's `AbortSignal` fires; it then gets a 5-second grace
(`TICK_PHASE_GRACE_MS`) to wind down. Still-running work is left **detached**
and its late rejection is swallowed — never an unhandled rejection, never a
record leaking into the next tick's ledger.

## Self-heal is incremental

One self-heal cycle used to verify every enrolled repo in turn, at up to
90 s per verify command, and start again at the first repo every tick. With
enough repos it hit the 5-minute phase deadline every time (`301740ms` on the
owner's Mac). Now:

- the cycle stops starting repos when less than 15 s of its 2-minute budget
  (`SELF_HEAL_CYCLE_BUDGET_MS`) is left, so the phase settles `ok`;
- each repo gets at most `SELF_HEAL_REPO_BUDGET_MS` (2 min); every verify
  command's timeout is capped at what is left of it, and a repo cut short is
  reported unverified, never green;
- `~/.ashlr/self-heal-cursor.json` names the last repo reached, and the next
  cycle starts after it. A large enrollment is covered over several ticks.
  The result reports `deferred` (repos not reached) and `budgetExhausted`.

## A stopped tick loop is a liveness state

The lock heartbeat runs on its own timer, so a resident whose loop stopped
moving still reported `alive` (5.6 h on the owner's Mac). The loop now writes
`~/.ashlr/daemon-tick-loop.json` each time it moves: when a tick starts, when
post-tick work starts, and before each park, with the time it expects to move
next. `phm daemon status --json` and `phm daemon doctor --json` report
`liveness.tickLoop.state`:

| state     | meaning                                                                 |
|-----------|-------------------------------------------------------------------------|
| `ticking` | in a tick, in post-tick work, or between ticks on schedule              |
| `parked`  | parked on purpose; `reason` says why (`paused`, `authority-withdrawn: …`, `budget-exhausted`) |
| `stalled` | alive, but more than 3 intervals (`TICK_LOOP_STALL_INTERVALS` × max(interval, 60 s)) past its expected move |
| `unknown` | no beacon from this daemon pid                                          |

`phm daemon doctor` exits 1 on `stalled`. An in-process watchdog checks the
same assessment every minute. On a stall it audits `daemon:tick-loop-stalled`
and wakes the loop out of its park. If the loop still has not moved one
threshold later, it stops with terminal failure `daemon-tick-loop-stalled`,
and launchd's `KeepAlive` (`SuccessfulExit: false`) starts a fresh resident.

## Health says why no frontier client resolved

`phm daemon health --json` lists each unresolved client in
`frontierClientsUnavailable`, with its inventory `reason` and `binaryOnPath`
for the `codex` and `claude` CLIs. `supervisor.detail` names the cause of a
`frontier-unavailable` or unreadable-inventory verdict, for example
`claude: unavailable-or-not-admitted ('claude' not on PATH)`. The PATH check
reads file metadata only. Resolution stays off the tick's critical path: the
tick's own `invent` probe is bounded at 30 s and skips the phase without a
client.

## Dispatched runs never block the tick

`superviseFleetTurn` bounds every turn — not just llama-server ones — at
`localFleet.taskTimeoutMs` (default 20 min, config
`daemon.localFleet.taskTimeoutMs`). Past that the turn is detached with a
`turn-deadline` outcome and the dispatch phase completes. The detached run
keeps its own engine backstops and stall monitor; the tick does not kill it.

A second resident tick refuses to start while a previously abandoned tick is
still open (`refused-open`), so two ticks can never race over shared state.

## Child processes on the tick path

Verification subprocesses (typecheck / test / build via
`runVerifyCommandAsync`) already run with hard timeouts, SIGTERM → SIGKILL
process-group escalation, and bounded drain. A phase deadline now also flows
into them as an `AbortSignal` — cancellation terminates the child process
group instead of waiting on it.

`log stream` denial watchers are file-polled, lifecycle-managed and never
awaited for exit: start blocks ≤ `STREAM_READY_TIMEOUT_MS` (3 s), the
end-of-run barrier waits ≤ `BARRIER_TIMEOUT_MS` (3 s), and `finish()` /
`abort()` stop the watcher with `SIGTERM`. Run disposal always aborts the
watcher, so it cannot leak past the run.

## No frontier client ⇒ invent is skipped

`invent` probes `resolvePlanningClient` against a 30-second bound. `null`
records `skipped: no-frontier`; a wedged probe records `timeout`. Neither
holds the tick open, so "no frontier client available" can never freeze
`lastTickAt` again.

## Mirror prep

`hooks.beforeTick`'s mirror preparation is wrapped as one `mirror-prep`
phase whose bound is the per-repo mirror deadline plus abort grace plus 30 s
of slack. The per-repo mirror internals (each git call bounded at 10 min,
the bounded repo lease, dependency installs) keep their own guarantees; this
phase only ensures the whole stage cannot outlive the tick.

## Budget

`phm daemon status` labels `--budget` "legacy --budget metered cap": it gates
metered USD spend only. $0 subscription and local-model work continues under
their own admission checks; the metered cap is not a stop for them.
