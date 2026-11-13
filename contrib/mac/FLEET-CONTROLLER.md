# Fleet controller (RQ-FLEET-LOADBALANCER-1)

One control loop for lane targets and holds. North star: merge throughput (merged PRs per hour) subject to host
stability and quota preservation. Code: `fleet_controller.py` (pure functions, no import-time effects) wired into
`dispatchd.py`. Tests: `tests/test_fleet_controller.py` (unit, one class per phase) and
`tests/test_fleet_controller_tick.py` (one dispatcher tick per case).

## Before and after

Five mechanisms acted on `slots.json` independently: the autopilot disk gate, the loadgate, memory pressure, usage
autobackoff and route hysteresis plus the hard caps. They shared no state and no objective, so they could contradict
each other and none looked at output. Now:

| Role | Mechanism |
| --- | --- |
| Signal provider | admission gate readings, memory, swap, disk gate, autobackoff / auth / credit holds, merge rows |
| Single writer | `SlotWriter`: every target or hold change goes through it, under `queue/fleet-controller.lock` |
| Decider | `fleet_controller.shed_level` / `plan` / `rebalance` / `backpressure` |
| Backstop (unchanged) | the admission gate, `hard_cap`, the HOLD list, route hysteresis |

## Phases

**A. Bus, writer, ledger (always on, no decision changes).**
`build_readings` is the one readings struct per tick: load1/5/15, ncpu, mem_free_pct, memory pressure, swap and swap
rate, procs, live worktrees, disk, queue depth by lane and by tier, per-lane quota remaining and burn (from
`budget-overrides.json`), merge rate 1h, CI/closed-unmerged rate. Unreadable is `None`, never zero. The concurrency
AIMD now reads the same struct (`concurrency_signals`). `SlotWriter` has no cap setter, clamps every target to
`min(hard_cap, pin)`, never overwrites a manual hold, and a second controller exits (lock held). One ledger line per
tick is appended to `metrics/fleet-controller.jsonl`; `status.json` gets a `fleet_controller` block.

**B. Graduated shed.** A pressure level 0..3 sets a factor on every lane's desired target:

| Level | Name | Factor | Entry (any signal) |
| --- | --- | --- | --- |
| 0 | normal | 1.0 | |
| 1 | shed50 | 0.5 | load1 >= 1.25 x ncpu; mem free < 25%; swap growth >= 25% of gate limit; procs >= 70%; worktrees >= 1.5x |
| 2 | shed25 | 0.25 | load1 >= 1.5 x ncpu; mem free < 15%; pressure >= 2; swap >= 50%; procs >= 85%; worktrees >= 2x |
| 3 | freeze | floors only | load1 >= 1.8 x ncpu; mem free < 8%; pressure >= 4; swap >= 75%; procs >= 100%; worktrees >= 3x; **any critical signal unreadable** |

Effective target = `min(desired, max(floor, ceil(desired x factor)))`. Escalation is immediate (can jump levels).
Restore is symmetric and slow: one level per `RESTORE_DWELL_S` (120 s), only while every signal is back inside 90% of
its entry band (memory: +5 points; load also needs load5 down). All bands sit below the admission gate's own trip
(2 x ncpu, pressure >= 2, swap growth > limit), which stays as the last-resort stop. On 18 cores the bands are load
22.5 / 27 / 32.4. The spec's "36 / 50 / 72" bands cannot be used as-is without loosening the gate, which trips at 36;
see REVIEW.md, decision 1. The ramp (+2) pauses while any shed level is active. The shed never changes the stored
target (the ramp's memory), only `effective_target`, which is what launches use (`tgt()` in dispatchd).

**C. Rebalance, output weight, backpressure.**
- *Rebalance.* A pool held by usage/auth backoff or credit exhaustion (never a manual or HOLD-list hold) hands queued
  lines to `codex-cmp` / `codex-personal` / `claude` that have idle slots (effective target - running - own queue > 0),
  same provider family first, then higher quality, tier fit from `models.json`. Moves go through the existing
  `route_decision` (move cap and launch lock bind; a backed-off pool counts as `hard_down`, like quota 0). At most the
  per-tick claim limit. Metered `claude-api`, `devin` (repo setup) and `codex-local` are never destinations.
- *Output-aware weight.* Merged share of resolved PRs per lane over 6 h gives a weight in [0.75, 1.0] (1.0 under 5
  samples). It multiplies the shed factor at levels 1 and 2 only, so weaker lanes shed first; it never raises anything.
- *Backpressure.* `queue/backpressure.json` carries a factor per tier and per lane (shed factor, held = 0, saturated
  tier = 3 / (queued per free slot)). dispatchd's own restock trigger honors it; queuegen can read it. It is advice
  with a 10 minute TTL and an `enforced` flag; missing or stale means no backpressure.

## Modes

`FLEET_CTL_MODE=shadow` (default): computes everything, applies none of B or C, writes the ledger with a `shadow`
block showing what enforce would have done. `FLEET_CTL_MODE=enforce` applies B and C; `FLEET_CTL_PHASES` (subset of
`abc`) narrows it. These are environment variables of the dispatcher job, not queue files: there is no flag file that can
be left behind to disable anything.

## Ledger line (`fleet-controller.ledger.v1`)

`{schema, ts, mode, shed_level, shed, shed_reasons, signals{load1, load5, load15, ncpu, mem_free_pct, memory_pressure,
swap_gb, swap_growth_gb, swap_rate_gb_h, procs, worktrees, disk_free_gb, disk_gate, queue_by_lane, queue_by_tier,
quota{lane: {remaining_pct, burn_pct_per_hour, credits_remaining}}, merge_rate_1h, ci_fail_rate, closed_unmerged_rate,
missing, degraded, holds}, lanes{lane: {target, desired, held, reason, quality}}, objective_score, objective, mutations,
reroutes, ambiguous_holds, shadow?}`. `objective_score` = merged PRs in the last hour x (1 - failure share), `null`
when the merge signal is unreadable. `fleet_controller.tail_ledger(path, n)` reads the last n lines for `phm fleet
status` and the desktop app. The file rotates once at 8 MiB (`.1`).

## Not in this change

- Reading the CI verdict per PR: outcome rows carry no CI field today, so `ci_fail_rate` is `null` and the closed-unmerged
  share stands in (named in `objective.fail_source`).
- The `phm fleet status` / desktop renderer (the ledger is the contract; reader helper provided).
- The 16-minute backlog-refresh stall in the Phantom daemon and the 9-day `LOADGATE_OFF` leftover: the repo copy of
  dispatchd already ignores that file (it only reports `off_switch_ignored`); the daemon stall is a different process.
