# World model

`phm world --json` is the snapshot the scheduler and the leaders read. `phm observe --json` and `GET /api/verse/observe` are a view of that same snapshot. The MCP tool is `world_model`.

```sh
phm world --json
phm world get sensors.lanes.claude-max.headroom --json
phm world --refresh --json
```

Schema: `ashlr.world-model/v1`. Every signal has `value`, `source`, `observedAt`, and `freshness` (`fresh`, `stale`, or `unknown`). A missing file, a stale sensor, or a probe that did not run has `value: null`. A real measured zero is only returned when the source was read and the count was zero.

`blindSpots` lists each unknown or stale field by path, with a stable id (`sensors.lanes.claude-max.pacePerHour` is `sensors-lanes-claude-max-pacePerHour`). The same rows are copied onto `views.observe.coverage.unknownFields`, beside the live and unknown counts. `claims.live` reads `coordinationSummary` from the claim store. A missing store is unknown, not zero. Sensor `burnRate`, `remaining`, and `idleIncludedWastedPerWeek` come from `usage.sensors.v1`. Optional `pacePerHour`, `requiredPacePerHour`, and `runwayHours` are read when a sensor row already carries them. Absent keys stay unknown. The strict sensor schema is unchanged.

The snapshot is cached in the process and at `~/.ashlr-runs/world/model.json` for 15 seconds. `phm world get` on a warm cache is the tick read. The tick does not call gh and does not read credential files.

The desktop resource bar reads this same snapshot from `GET /api/verse/world`. There is no world-model event stream, so the bar polls that route once per cache window while it is on screen. Each lane row shows usage, remaining, reset, burn rate, and the exhaustion-versus-reset gauge, plus the field's source and `observedAt`. A missing key, a null, or a reading past the 15-minute usage-sensor staleness window is unknown. The bar does not invent a number. Reset time and `forecastVsReset` are taken from the lane when a pacing row includes them, and otherwise from that snapshot's observe window.

A path that is not in the snapshot returns `{ "path", "freshness": "unknown", "value": null }`.

```sh
HOME=$(mktemp -d) npm run test:ci -- test/world-model.test.ts
```
