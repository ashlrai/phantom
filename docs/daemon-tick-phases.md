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

## Tick outcomes

`.tick.outcome` folds the phases plus whole-tick failure into one word:

- `ok` — every phase settled clean.
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
| `self-heal`      | 5 min            | `TICK_PHASE_MAINTENANCE_MS`; verify subprocesses ≤15 min|
| `invent`         | 3 min            | `TICK_PHASE_INVENT_MS`; frontier probe ≤30 s            |
| `ancillary`      | 5 min            | `TICK_PHASE_MAINTENANCE_MS`                             |
| `reflection`     | 3 min            | `TICK_PHASE_REFLECTION_MS` (nested inside `ancillary`)  |
| `auto-merge`, `proposal-repair` | 5 min | `TICK_PHASE_MAINTENANCE_MS`                   |
| `capacity`       | 30 s             | `TICK_PHASE_CAPACITY_MS`; internally probed             |
| `dispatch-plan`  | 60 s             | `TICK_PHASE_DISPATCH_PLAN_MS`                           |
| `dispatch`       | worst-case turns | `tasks / slots` × (turn watchdog + grace)               |
| `dispatch-hook`  | 60 s             | per-item `afterDispatch` hooks                          |

At a deadline the phase's `AbortSignal` fires; it then gets a 5-second grace
(`TICK_PHASE_GRACE_MS`) to wind down. Still-running work is left **detached**
and its late rejection is swallowed — never an unhandled rejection, never a
record leaking into the next tick's ledger.

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
