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
| `phm pools` | One row per resource, most at risk of waste first: used percent, reset time, hours left, burn per hour, projected unused percent at reset, waste risk, running jobs against the slot target, the reader behind the reading, its as-of time and any per-model windows. JSON (`pools.v1`) by default, `--text` for people. A stale or missing reading is `unknown` with a `reason`, never zero. | `src/core/fleet/pools-view.ts` over the resource ledger |
| `phm pools spenddown` | One row per plan for the spend-down chart: `used_frac`, `reset_at`, `even_pace_frac` (where a straight line from the last reset would be now), `projected_at_reset` and a plain verdict ("on pace", "will leave 12% unused: add work", "drained until Fri 6 PM", "no reading"). JSON (`pools.spenddown.v1`) by default, `--text` for people. The desktop Spend down panel and the phone Home card draw one row per plan from it: a used bar, a line for even pace, a diamond for where it ends at reset. | `src/core/fleet/pools-spenddown.ts` over `pools.v1`; `GET /api/app/pools/spenddown` |
| `phm pools waste [--json]` | Which pool is about to waste included usage, with the one fix in plain words ("sign in to Gemini once: run gemini in a terminal", "queue more work for Claude", "lane held: <reason>"). Flags a pool that resets within 12 h and has waste risk high or at least 25% projected unused; no current reading is listed as unknown, never flagged. The top alert is the hourly digest's waste line, and a sign-in fix is also raised as a phone Asks card. JSON is `pools.waste.v1`. | [`pools-waste.ts`](../src/core/fleet/pools-waste.ts) |
| **Pools pane** (desktop dock) | The same rows as one board. Each pool is a card with its plain-words line ("on pace", "behind: 30% would go unused", "unknown: no reading since ..."), a bar (solid: used so far; lighter: where the current burn ends by reset; marker: time elapsed in the window) and labelled readings: used, left, reset countdown and local time, burn per hour with its basis, unused at reset, jobs running against the slot target, and how long ago the reading was taken and by which reader. Per-model windows (Claude meters some models on their own weekly window) are listed under the pool with their own thin bar. A credits pool shows its balance and no bar; an unmetered lane shows its jobs only. The line under the headline names the next reset. Narrow the list to Behind, On pace or Unknown with the switch (arrow keys); each choice shows its count. A value the view does not hold reads `unknown`, never zero. | `GET /api/app/pools` |
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
