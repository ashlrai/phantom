# Personal usage proof — diagnostic recipe

How an agent collects evidence that the **personal** Codex weekly meter is
actually moving, without confusing it with the CMP seat or with a Claude
quota. This serves the Oct 30 23:45 order (prove personal usage is moving)
and the Claude five-hour-removal order (no Claude session cap exists to
rediscover).

All commands are read-only and local. Use `--json` output for provenance.

## Boundaries

- The personal home is `~/.codex-2`. `~/.codex` is the CMP seat
  (`codex-cmp`): never read, list, or merge it into personal evidence. Both
  commands below scope themselves to `~/.codex-2`; `personal --home` rejects
  any path containing a `.codex` component.
- The `claude` lane is weekly-only. Claude has no five-hour session cap;
  values in historical rows, screenshots, or notes from before the removal
  are history, not a contract. Do not infer a new Claude session cap from
  them, and do not substitute a Codex session window for a Claude one.
- No command here performs an authenticated provider call, and none exists
  for that purpose. `auth.json` is never opened; the only provider evidence
  is the rate-limit snapshot the codex CLI already writes into its own
  session logs. Do not invent a direct-provider auth call — no credential
  reads, no usage API requests.

## What each command reads

| Command | Evidence kind | Source read |
| --- | --- | --- |
| `phm resources personal [--json] [--home <absolute-path>]` | Samples **local provider evidence** | Newest `rollout-*.jsonl` under `~/.codex-2/sessions/` (allowlisted rate-limit fields only; nothing else in the home is opened). No history written, no provider contacted. |
| `phm resources ledger [--json]` | Reads **dispatch status** plus the same local sample | `~/.ashlr-runs/queue/status.json` lanes and budget, `metrics/api-spend.jsonl`, `metrics/jobs.jsonl`; then merges a `~/.codex-2` session sample into the `codex-personal` lane when strictly newer than the status tick. |
| `examples/agents/personal-usage-follow.ts` | Bounded **repeat observation** of the local sample | Same `~/.codex-2` collector; emits JSONL `sample` records and a `summary` with `weeklyUsedPctDelta`. |

## Recipe

1. **Baseline.** `phm resources personal --json`. Record
   `resources[0].observedAt` (the provider snapshot timestamp),
   `resources[0].weekly.usedPct`, `resources[0].weekly.resetsAt`, and
   `resources[0].state`. Exit 0 means `state: "current"`; exit 1 means stale
   or unavailable evidence — an unknown, not a reading, and never a success.
2. **Dispatch context.** `phm resources ledger --json`. For
   `lanes[]` where `lane === "codex-personal"`, record `running`, `target`,
   `usedPct`, `source`, and `observation.asOf`. Lane `running`/`target` show
   what dispatch is doing, not what the meter did. `source:
   "codex-personal-sessions"` means the lane carries a local session sample
   stamped `observation.asOf`; `source: "status"` means it carries the
   dispatcher's own figure. Top-level `asOf` is the status tick;
   `generatedAt` on either command is report construction time — neither is
   a provider observation.
3. **Repeat observation.** After the agent does work, take a second
   `personal` reading (or run
   `npx tsx examples/agents/personal-usage-follow.ts --samples 2
   --interval-ms 60000`, which prints `weeklyUsedPctDelta`, `null` when the
   samples are not comparable).
4. **Judge.**
   - *Measured change:* the second reading is `current`, its `observedAt`
     is strictly later, `weekly.resetsAt` is unchanged (same window), and
     `weekly.usedPct` differs. Report it as "weekly moved A% → B% between
     observations T1 → T2".
   - *Same snapshot re-read:* equal `observedAt` means the provider has not
     written a new sample; a changed `generatedAt` alone is nothing.
   - *Unknown:* `state` is `stale` or `unavailable`, `observedAt` is missing
     or in the future, `usedPct` is `null`, or the window reset between
     samples. Report unknown — never 0%, never "unchanged", never success.
5. **Freshness gate (optional).** `phm resources ledger --json
   --check-fresh-seconds N` adds `freshnessCheck` (`pass`/`stale`/`unknown`,
   exit 1 unless `pass`) on the status tick. A stale tick means the lane
   rows are historical even when they print numbers.

## Measured change versus a projection

`burnPctPerHour`, `runwayHours`, and `projectedExhaustionAt` are computed
from stored samples and are **projections**. The `personal` command keeps no
history, so they are `null` in its output — expected, not an error. In the
ledger they may arrive via the status file's own observation history. A
projection says where usage would land at the measured rate; it is not proof
the meter moved. Only two timestamped `current` readings constitute
measured change.

## Stale and unknown handling

- `state: "current"` — a reading exists and `observedAt` is at most 24 h old.
- `state: "stale"` — a reading exists but is older (or has no timestamp);
  the command exits 1 and the figure is a last-known value, not evidence.
- `state: "unavailable"` — no usable window; exits 1. Unknown is never
  reported as 0%.
- A future `observedAt` is not trustworthy: the ledger refuses to merge it,
  and the follow helper refuses to compare it.
- The ledger merges a personal session sample into the `codex-personal`
  lane — creating the row when the status file reports none — only when the
  sample is not future-dated and is strictly newer than the status tick (or
  the tick is unparseable and the status weekly value is unknown). Older or
  equal evidence leaves the `source: "status"` figure in place.

## What does not count as proof

A busy lane (`running` > 0), recent commits, an advancing `generatedAt`, or
an approaching `projectedExhaustionAt` do not show a fresh provider sample.
CMP (`~/.codex`) values must never appear in a personal proof. A Claude lane
percentage is a weekly figure only — there is no Claude session meter to
cross-check against.
