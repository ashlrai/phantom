# Human observe

`phm observe --json` is the read-only snapshot the desktop panes render. The MCP tools `phantom_observe` and `phantom_observe_session` call the same function. Nothing here spends, merges, or reads app databases, keychains, or credentials.

```sh
phm observe --json
phm observe session <id> --json
```

The desktop route is `GET /api/verse/observe`. A session drill-down is `GET /api/verse/observe/session?id=<id>`. The transcript field stays null until a desktop operator reader is registered.

`phm observe --json` reads the world model in [WORLD.md](WORLD.md). `coverage.fields` is still the live and unknown counts. `coverage.unknownFields` lists each unknown or stale field by path, with the same stable id as `blindSpots`.

## Baseline, 3.30.24

Captured read-only at 2026-11-09 00:24 ET from Phantom 3.30.24.

| | Before | After |
| --- | --- | --- |
| Sidebar panels | 10 (Command, Fleet, Growth, Mind, Chat, Agents, Needs you, Resources, Notifications, Settings) | same 10, no new sidebar section |
| Fleet panes in the bundle | 19 | same panes, with one observe slice each on Usage, Capacity, Graph, Releases, Merges, Timeline, and Bus |
| Data sources | 8 | those 8, plus the observe snapshot sources below |
| Fields in the capture | 4 live, 10 unknown, 1 stale, 2 absent | `coverage.fields` on each snapshot |

The stale field was the Resources last reading (about 47 hours old) shown in the current slot. Sensor headroom that is null is now labeled unknown. An empty Devin consumption report is unknown, not "0 ACUs reported". "Update check failed" is a release-pipeline stage.

## Sources

| Source | Live when | Pending or unknown when |
| --- | --- | --- |
| `phm agents roster --json` (`collectAgentRoster` in `agent-roster.ts`) | a probe reports `availability: known` | the probe times out, is missing, or has no documented shape |
| `desktopSessions()` | a visible Devin Desktop, Cursor, or Grok window is listed | the desktop operator is not readable. Those three rows stay unknown |
| `phm usage sensors --json` (`presentUsageSensors`) | a lane is fresh and headroom is a number | stale, unmeasured, or no snapshot file. Headroom null is unknown |
| `inspectBusWorkClaims` | the claim table is missing or valid | the table cannot be read |
| `~/.ashlr-runs/export/human-steps.json` | schema `ashlr.human-steps/v1` | file missing or invalid |
| `~/.ashlr-runs/export/bottlenecks.json` | schema `bottlenecks.v1` | file missing or no measured rows |
| pull export (`--prs`) | a complete gh-shaped file | no file, or the list is truncated |
| desktop update phase | the caller passes a phase | the CLI cannot see the Mac update bridge |

## Resources

A resource is one of: Devin cloud, Devin desktop, Codex personal, Dot, Cursor cloud agents, Claude sessions, Grok Bot teammates, Ollama or oMLX.

- Coordinated: reachable through the roster (or a Phantom worker on that lane) and holding or completing a bus claim inside the window (default 15 minutes).
- Idle: reachable, sensor headroom above zero, and no claim in the window.
- Duplicated: two or more claims or sessions share a task title or claim key.
- Unknown: not reachable, or reachable without a fresh headroom reading. Unknown is never counted as idle.

Each resource row includes a `gauge`: remaining and its unit, burn per hour, `forecastExhaustAt`, `forecastVsReset` (`early`, `on-pace`, `underuse`, or `unknown`), and `idleIncludedWastedPerWeek`. A missing burn or reset leaves those fields null. Null is not zero and does not make the resource idle.

The scheduler (`planLanes`) narrows a lane when `phm usage sensors` has a fresh included-usage pace: remaining, divided by time to reset, divided by the burn of one job, with a 15 percent safety margin, then clamped to the lane ceiling. `~/.ashlr/KILL` sets every lane to 0. `claude-api` stays at 0 unless a fresh balance exists and spend is approved. Local models have no allowance; the gauge reports throughput only. Devin's ACU cap is not raised. SWE-2 Flash and the weekly included allowance are separate rows.

When no resource is reachable, the coordinated, idle, and duplicated counts are null.

Codex personal is reachable from a Phantom worker whose lane is `codex-personal`, or from a roster probe named `codex-personal`. The generic `codex` probe is not that pool. Dot has no probe until one is registered.

## Human steps

```json
{
  "schema": "ashlr.human-steps/v1",
  "generatedAt": "2026-11-09T05:00:00.000Z",
  "source": "eng-ops",
  "stepsRemaining": 2,
  "decisions": [
    { "id": "approve-observe", "at": "2026-11-09T05:00:00.000Z", "kind": "approval", "title": "Ship the observe snapshot", "actor": "eng-ops", "status": "pending" }
  ]
}
```

`stepsRemaining` is a non-negative integer. Zero is a real zero. A missing file is unknown, not zero.

## Bottlenecks

Eng Ops ranks the weekly file. Observe keeps that order and shows at most three measured rows. Metrics: `worktree_checkout_time`, `worktree_checkout_count`, `ci_minutes`, `merge_queue_wait`, `rebase_churn`, `release_merge_to_installed`, `lane_underfill`.

```json
{
  "schema": "bottlenecks.v1",
  "generatedAt": "2026-11-09T05:00:00.000Z",
  "source": "eng-ops",
  "items": [
    { "id": "ci-minutes", "metric": "ci_minutes", "value": 42, "unit": "minutes_per_pr", "owner": "ci", "before": 80, "after": 42, "verifiedAt": "2026-11-08T00:00:00.000Z" }
  ]
}
```

`before` and `after` are null until a fix is measured. They are not invented.

## Pull headlines

`--prs <file>` reads a JSON array, or `{ "pulls": [], "complete": true }`. Each row needs `repo`, `number`, `state` (`open`, `merged`, or `closed`), and `createdAt`. Optional: `mergedAt`, `closedAt`, `queueWaitSeconds`, `ciDurationSeconds`, `reverted`, `fixForward`, `failedRelease`.

Merged pulls per day is the merged count divided by the window (default 7 days) when the export is complete. Change-failure rate is reverts plus fix-forward pulls plus failed releases, divided by merges, and only when every merged row has those three labels. Otherwise the rate is null. A truncated export makes the repo unknown.

Queue wait and CI duration are medians of the supplied seconds. Missing seconds stay null.

## Checks

```sh
HOME=$(mktemp -d) npm run test:ci -- test/observe-human.test.ts
```
