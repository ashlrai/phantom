# Fable 5.2 orchestration

RQ-FABLE-ORCH-REG-2 implements the repository portion of EO
RQ-FABLE-ORCHESTRATOR-1, following [registration #4506](https://github.com/ashlrai/phantom/pull/4506).
This is a distinct queue key, not a retry of REG-1.

Fable 5.2 is a Claude subscription planning seat. The native Leader selector
prefers it only after normal authority, account and quota admission plus the
Fable weekly pacer. Worker coding and Thompson exploration cannot select it.
Manager callers may identify architecture, intent triage, bottleneck analysis,
or difficult review/decomposition using `orchestrationWork`. Frontier coding
alone does not qualify. No API credential fallback is added.

The pacer reads `routing/fable-weekly.json` below the Ashlr configuration root.
It accepts only schema version 1, source `claude-usage`, unit
`overall-weekly-percent`, a numeric `sharePercent` (hard clamped to 0–50), and
`reading` with these numeric fields:

- `observedAtMs`, `resetAtMs` (Friday 18:00 America/New_York)
- `claudeWeeklyUsedPercent`, `fableOverallWeeklyUsedPercent`
- `codingBurnPercentPerHour`, `nextPlanPercent`

The second percentage must be measured against the overall Claude weekly
allowance. The existing `seven_day_fable` model-window percentage is not that
measurement. Token totals and local list-price estimates cannot provide it.
Missing, inconsistent or 15-minute-old readings disable admission. The current
checkout has no producer of this same-denominator attribution: Fable therefore
stays unavailable until reliable telemetry is supplied. Do not fabricate a
reading or convert model-window percentages to enable it.

The pacer preserves measured coding burn through reset and a next-plan allowance,
and caps consumption at the configured share. The world lane `claude:fable`
exports both overall weekly percentages, including unknowns; the resource bar
labels it as planning and orchestration. Unconfirmed context limits stay at a
conservative 200k without expansive mode.

Native upstream billing frames persist only a reason ID in
`routing/fable-billing-stop.json`. The stop survives resets and clean responses.
A human may re-enable by removing the stop after investigating billing and
restarting the host process; the process also retains a stop if persistence
fails. Model execution has no reset command. Null fallback credit, 429,
rate-limit errors, token counts and local price estimates never stop Fable.

## Host handoff still required

`contrib/mac/dispatchd.py` copies the exact `SUBLANE claude:fable` base metadata
into Claude job metrics. No live dispatcher is installed by this change.
The pinned launcher candidate is under `contrib/mac/host-integration/`; the
loopback credential broker itself is not in this checkout. Its HTTP response
billing fence, launch-path `fable-share` control and reservation accounting must
be reviewed together before enabling host Fable dispatch. The native adapter's
streamed-frame stop does not prove the external broker's HTTP behavior.
Concurrent launches also need atomic allowance reservations; a fresh sensor
snapshot alone is insufficient to guarantee a cumulative hard limit.

No free-reset action is implemented or authorized here. EO must notify Masbot
before the separately approved reset procedure when the allowance is nearly used.
