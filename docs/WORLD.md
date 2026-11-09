# World model

`phm world --json` is the snapshot the scheduler and the leaders read. `phm observe --json` and `GET /api/verse/observe` are a view of that same snapshot. The MCP tool is `world_model`.

```sh
phm world --json
phm world get sensors.lanes.claude-max.headroom --json
phm world --refresh --json
```

Schema: `ashlr.world-model/v1`. Every signal has `value`, `source`, `observedAt`, and `freshness` (`fresh`, `stale`, or `unknown`). A missing file, a stale sensor, or a probe that did not run has `value: null`. A real measured zero is only returned when the source was read and the count was zero.

`blindSpots` lists each unknown or stale field by path, with a stable id (`sensors.lanes.claude-max.pacePerHour` is `sensors-lanes-claude-max-pacePerHour`). The same rows are copied onto `views.observe.coverage.unknownFields`, beside the live and unknown counts. Resource pacing (`pacePerHour`, `requiredPacePerHour`, `runwayHours`) is read when a sensor row carries those keys. Until RQ-SENSORS-PACE-1 lands, those fields stay unknown.

The snapshot is cached in the process and at `~/.ashlr-runs/world/model.json` for 15 seconds. `phm world get` on a warm cache is the tick read. The tick does not call gh and does not read credential files.

A path that is not in the snapshot returns `{ "path", "freshness": "unknown", "value": null }`.

```sh
HOME=$(mktemp -d) npm run test:ci -- test/world-model.test.ts
```
