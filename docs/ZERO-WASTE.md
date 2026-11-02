# Zero Waste

## What "zero waste" means for the fleet

Zero waste means every provider's remaining usage is spent before its reset
deadline.  A held lane that still has budget sitting in its window is waste —
a window that resets with usage left over could have been executing useful
work.  Every lane's budget should be driven toward 100 % consumption before
the provider's scheduled reset point.

## Where to look

| Surface | What it shows | Source |
|---------|---------------|--------|
| **Resources bar** (desktop console rail foot) | Per-account battery: how much of each binding window is left, reset instant, and reserve kept for the operator. | `src/web-ui/routes/verse/resources/ResourcesBar.tsx` |
| **Fleet usage pane** (desktop console drawer) | Every window with its reset, the burn rate and projected exhaustion per lane. | `GET /api/verse/leader/resources` (`usedPct`, `creditsRemaining`, `resetAt`, `burnPctPerHour`, `projectedExhaustion` from `src/core/fleet/runs-resource-ledger.ts`) |
| **Notification bell** | Urgent and critical alerts derived from the fleet ledger — signals when a lane is approaching its reset without consuming its window. | `src/web-ui/components/notifications/NotificationBell.tsx` |
| `ashlr resources` | Table view: engine, availability, used %, cap, resets-in, cost. Flags: `--json`, `--watch`. | `src/cli/resources.ts` |
| `ashlr resources --json` | Raw JSON — full `ResourceSnapshot` of every backend. | `src/cli/resources.ts` |

## What to do when a lane is held with usage left

When a lane is held (flagged `held: true` or `held` in the slots file) while
its window still has budget, the hold is consuming time without producing work.
Unhold the lane through the normal fleet control process so that remaining
budget can be spent before the window resets.  See

* [Lane Holds](./LANE-HOLDS.md) — how holds work, how to spot a stale hold,
  and how to unhold a lane.

## Related documentation

* [Resource Ledger](./RESOURCE-LEDGER.md) — full field glossary for
  `ResourceLedgerV1` and `ResourceLaneRow`.
* [Reset-aware Scheduling](./RESET-AWARE-SCHEDULING.md) — how the fleet
  uses fresh deadlines to select useful work before a provider reset.
* [Usage Signals](./USAGE-SIGNALS.md) — event-driven usage readings that
  feed the burn-rate and exhaustion projections.
