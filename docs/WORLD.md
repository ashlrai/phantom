# World model

`phm world --json` is the snapshot the scheduler and the leaders read. `phm observe --json` and `GET /api/verse/observe` are a view of that same snapshot. The MCP tool is `world_model`.

```sh
phm world --json
phm world get sensors.lanes.claude-max.headroom --json
phm world --refresh --json
```

Schema: `ashlr.world-model/v1`. Every signal has `value`, `source`, `observedAt`, and `freshness` (`fresh`, `stale`, or `unknown`). A missing file, a stale sensor, or a probe that did not run has `value: null`. A real measured zero is only returned when the source was read and the count was zero.

`growth` holds the latest reading of each Growth chart series (`mergesPerHour`, `pullsOpened`, `pullsMerged`, `releases`, `laneUtilization`, `costPerMergedPr`, `bottleneckTrends`). A series with no ledger is unknown here and is listed in `blindSpots`. It is not stored as 0. See [Growth charts](GROWTH.md).

`blindSpots` lists each unknown or stale field by path, with a stable id (`sensors.lanes.claude-max.pacePerHour` is `sensors-lanes-claude-max-pacePerHour`). The same rows are copied onto `views.observe.coverage.unknownFields`, beside the live and unknown counts. `claims.live` reads `coordinationSummary` from the claim store. A missing store is unknown, not zero. Sensor `burnRate`, `remaining`, and `idleIncludedWastedPerWeek` come from `usage.sensors.v1`. Optional `pacePerHour`, `requiredPacePerHour`, and `runwayHours` are read when a sensor row already carries them. Absent keys stay unknown. The strict sensor schema is unchanged.

The snapshot is cached in the process and at `~/.ashlr-runs/world/model.json` for 15 seconds. `phm world get` on a warm cache is the tick read. The tick does not call gh and does not read credential files.

Each refresh also writes `ashlr.world-export/v1` to `~/.ashlr-runs/export/world.json` (override with an absolute `ASHLR_WORLD_EXPORT`). The file is the snapshot plus live claim rows. It does not contain fencing tokens.

```sh
phm context --for-agent claude --json
phm claim acquire repo:ashlrai/phantom --lane claude --json
phm claim release repo:ashlrai/phantom --lane claude --reason merge --json
```

`phm context --for-agent` returns `ashlr.context-brief/v1`, at most 4KB: who holds a live claim (claim id, lane, repo, pull or branch, started), open pulls, the top bottlenecks and blind spots, and that lane's pacing. `phm claim acquire` refuses when a live claim overlaps the work key or an open pull touches it, and returns the holder. Release reasons are `open`, `merge`, and `abandon`. The same two calls are the MCP tools `phm_context_brief`, `phm_claim_acquire`, and `phm_claim_release`. `phm context read` and `phm context write` stay the company context verbs.

A path that is not in the snapshot returns `{ "path", "freshness": "unknown", "value": null }`.

```sh
HOME=$(mktemp -d) npm run test:ci -- test/world-model.test.ts
```
