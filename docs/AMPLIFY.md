# Amplify

`phm amplify` turns the standing objective into an offline advisory loop:
maximize verified, durable engineering outcomes from available fleet capacity,
using expiring included capacity within existing security, spending and
publication authority.

```sh
phm amplify status --json
phm amplify tick --json
phm amplify goal --limit 10 --json
```

`status` reports per-pool `used_pct`, reset/expiry countdowns, burn in percentage
points per hour, projected waste, running/target saturation, heartbeat findings,
controller vitals, one-hour merge velocity and up to 20 priority-sorted actions.
`goal` prints the objective and the last N valid decisions (newest appended first;
default 10, maximum 100) from `leader/decisions.jsonl`.

`tick` reads the same snapshot and appends one `amplify.tick.v1` JSONL record with
`type: "ADVISORY"`, the snapshot, source states and proposed actions to
`metrics/amplify.jsonl`. This is the command's only write. An iteration with no
recommendations still records an empty actions array. Nothing dispatches work,
changes targets, clears holds, merges, spends or accesses credentials.

All paths are relative to `ASHLR_RUNS_DIR`, default `~/.ashlr-runs`. Readers reuse
the fleet's bounded, symlink-refusing metadata reader:

- `queue/resources-ledger.json` (root `resources-ledger.json` fallback only when
  absent): `{ "as_of": "UTC timestamp", "pools": { "pool-id": { "used_pct": 20,
  "reset_at": "UTC timestamp", "expires_at": "UTC timestamp",
  "burn_pct_per_hour": 2 } } }`. Rows may have their own `as_of`.
- `queue/budget-overrides.json`: existing per-pool `weekly_used_pct`, `as_of`,
  `reset_at`, `burn_pct_per_hour`, plus optional `expires_at`.
- `queue/status.json`: `last_tick`, `lanes` running/target/held and `budget`
  readings with their own `observed_at` or `as_of`.
- `metrics/fleet-controller.jsonl`: latest record's epoch-seconds `ts` and
  `signals` (`load1`, `mem_free_pct`, `swap_gb`, `disk_free_gb`, `merge_rate_1h`).
- `supervisor/status-*.md`: heartbeat timestamps in the first twelve lines.

A fresh override takes precedence over a fresh ledger row, then a fresh status
budget row. Each selected observation stays intact: usage, burn and deadline
are never combined across sources. Readings older than 30 minutes, future-dated
readings, invalid values and elapsed windows produce null measurements. Countdown
fields remain diagnostic and clamp elapsed deadlines to zero. Missing burn is
unknown; a measured zero burn is valid. Missing data never means zero usage.

Projected waste is `max(0, 100 - used_pct - burn_pct_per_hour * hours_remaining)`
at the earlier known reset or expiry. It assumes steady burn; it is not a claim
about transferable quota or additional spending authority. A recommendation is
raised for at least 10 percentage points of projected waste within 24 hours.
Saturation is `running / target`; a zero target has unknown saturation.
Merge velocity uses the controller's actual one-hour merge signal, not the
24-hour launch cohort. Unknown or stale vitals stay null.

Decision records accept `at`/`ts`/`timestamp`, a string `decision`/`summary`/`action`,
and optional string `rationale`/`reason`. Unsupported or malformed rows mark the
source degraded and are omitted. Free text is scrubbed and capped; arbitrary
fields are never replayed. JSON reads are capped at 256 KiB; controller and
decision tails at 1 MiB; at most 64 pools and supervisor files are inspected.

The TypeScript `leaderTick` runs the same advisory pass on every cycle, including
cycles without a model run. A failed advisory append is reported and does not
stop normal leader work. The next memo receives the objective and proposed
actions in an **UNTRUSTED DATA** block. Snapshot clocks are excluded from that
context so an otherwise unchanged observation does not force a new memo.
The host's pinned `leader-tick.sh` has no source mirror here; it is unchanged.
No live installation is part of this change.

Exit codes: 0 report/record written (including missing evidence), 1 IO failure,
2 invalid usage. `--limit` is accepted only for `goal`. Use `--help` for syntax.
