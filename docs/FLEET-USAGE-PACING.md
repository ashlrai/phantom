# Manual fleet usage pacing

This offline command reads `~/.ashlr/fleet.json`. Configure an explicit reset
instant with a timezone before adding readings:

```json
{
  "usage": {
    "grok-ultra-weekly": {
      "resetAt": "2026-10-28T13:15:00Z",
      "readings": []
    }
  }
}
```

```sh
phm fleet usage add grok-ultra-weekly 49 --at 2026-10-26T01:30:00Z
phm fleet usage add grok-ultra-weekly 63 --at 2026-10-26T13:15:00Z
phm fleet usage --json
```

The latest two observations give 14 / 11.75 = 1.1915 percentage points per
hour. The 12h rate uses the earliest and latest observed endpoints within the
trailing 12 hours. Missing intervals return null, never a guessed zero.
A percentage decrease starts a new observed window. Old readings remain in
the file. Update resetAt when the subscription resets.

The pace needed is `(100 - latest percentage) / hours until reset`, floored at
zero: the target is the full subscription pool with no reserve held back
(`USAGE_PACE_TARGET_PCT`, per the Nov 5, 2026 no-reserve order). Run-out
projects 100% from the latest reading at the last-two rate.
Expired reset times disable projections and report `reset-expired`.
The report does not extrapolate unobserved consumption into the current
percentage. Manual readings should be refreshed before operational decisions.

`fleetUsageReport` is the common contract for RQ-PARITY-TOP and routing
consumers: schemaVersion, at, and pools keyed by pool id. Each pool echoes
resetAt and latest (the newest in-window reading or null), then reports
pointsPerHour, pointsPerHour12h, paceNeeded, projectedRunOutAt, throttle,
preferMacPools, boxAgentTurnMultiplier and status — `ready`,
`insufficient-readings`, `no-readings` or `reset-expired` — so a consumer
never mistakes missing or expired evidence for a measured pace. When the
last-two rate exceeds the needed pace, or usage reaches 100%,
preferMacPools is true and boxAgentTurnMultiplier is 0.5. Otherwise it is 1.
These are advisory outputs only in this change. The existing routers are
Tier-1 protected and do not yet consume them. No RQ-PARITY-TOP consumer exists
in this checkout. Integrating those consumers requires a separate authorized
change; JSON consumers can use the same report without recomputing numbers.

Writes use the existing local-store lock and private atomic file writer,
preserve other fleet fields, and reject duplicate or out-of-order timestamps,
future readings, invalid percentages and unknown pools. Malformed state is
reported as an error and never overwritten.
