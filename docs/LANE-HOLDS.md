# Lane Holds

## Hold vs. Pause vs. Global HOLD

A **hold** on a lane keeps the lane's current `target` in the slots file but
prevents the dispatcher from launching work.  The lane record persists with its
original floor / ceiling / target.

A **pause** (target 0) makes the lane idle.  The **global HOLD switch** is a
separate file that freezes all lanes; it is not part of the lane-target model.

## LaneTargetRow fields

| Field | Type | Meaning | `null` means |
|---|---|---|---|
| `held` | `boolean` | Whether the lane is currently held back. | The lane was never held since the slot was created. |
| `heldReason` | `string \| null` | Why the lane is held (see sections below). | No reason recorded — the lane is not held. |
| `heldUntil` | `string \| null` | ISO-8601 timestamp after which the hold expires. | No expiry — the hold is manual (never removed by software). |
| `lastChange` | `string \| null` | ISO-8601 timestamp of the last update to `target`, `held`, or floor / ceiling. | The lane record exists but has never been modified. |
| `changedBy` | `string \| null` | The identity that made the last change (newest trailing ISO among `unheld_by`, `held_by`, `changed_by`). | The lane record exists but has never been modified. |

The endpoint that exposes these fields is `/api/verse/fleet/control/lanes`.

## Automatic holds

The dispatcher places an automatic hold when it needs to back off a lane.
`held_by` is always `"autobackoff"`.  The `heldReason` format:

```
autobackoff <pattern> job=<job id> until=<iso> src=<cli_line|default|outcome_unreadable>
```

- `src=outcome_unreadable` and `src=default` mean the end time was a guess of
  at most **six hours**, not a provider reset.
- Automatic holds **are removed** by software when `heldUntil` passes.

Example row (fictional):

```json
{"lane":"compute-gpu-a100","held":true,"heldReason":"autobackoff rate-limited job=8f3a1c until=2025-11-15T14:30:00Z src=cli_line","heldUntil":"2025-11-15T14:30:00Z","lastChange":"2025-11-15T08:30:00Z","changedBy":"autobackoff 2025-11-15T08:30:00Z"}
```

## Manual holds

A hold whose `held_by` is **anything other than** `"autobackoff"` was placed by
a person.  Manual holds **are never removed by software** — only an operator
clears them via `setLaneTarget`.

Example row (fictional):

```json
{"lane":"compute-gpu-a100","held":true,"heldReason":"blocked pending vendor quota review","heldUntil":null,"lastChange":"2025-11-10T09:15:00Z","changedBy":"mason 2025-11-10T09:15:00Z"}
```

## A hold can be stale

The provider quota window may reset **before** `heldUntil` expires.

**Spot a stale hold:** compare `lastChange` (from the lane record) with the
reading time from `GET /api/verse/leader/resources`.  If the reading time is
newer than `lastChange` **and** `usedPct` is below 25 %, the quota window
likely reset and the hold is stale.

## Reading holds

- **Slots:** `GET /api/verse/fleet/control/lanes`
- **Resources:** `GET /api/verse/leader/resources` (check `usedPct` + time).
- **CLI:** `ashlr resources ledger`
- **Audit log:** `~/.ashlr-runs/queue/lane-target-changes.log` (ISO time, lane,
  old→new target, actor).

No release route exists on master; holds persist until a provider reset makes
them stale or an operator clears them with `setLaneTarget`.
