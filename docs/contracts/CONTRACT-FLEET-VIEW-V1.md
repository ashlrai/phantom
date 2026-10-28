# CONTRACT-FLEET-VIEW-V1: the live fleet projection

**Task:** RQ-FLEET-VIEW-V1 (Ashlr router queue): one live view for humans
and agents, built on `phm fleet status --json` (fleet.v1) and the
fleet-dashboard handoff: not around them.

**Hard rules:** read-only everywhere; `null` means unknown and is never
fabricated as zero; no new tokens or auth; the remote page stays
allowlisted, authenticated and secret-scanned; the CLI handler stays thin
(dispatch only: logic lives in `src/core/`).

## Surfaces

- `phm fleet view [--json] [--once] [--interval <ms>]` - `src/cli/fleet.ts`
  dispatches to `runFleetViewTui` (`src/tui/app.ts`), which renders
  `renderFleetViewFrame` (`src/tui/render.ts`) on the fleet-view.v1
  document. `--json` prints the document; `--once`/non-TTY renders one
  frame; interactive mode enters the alt screen at a 2 s cadence (interval
  bounds 250-30000 ms), `r` refreshes, `q`/Esc/Ctrl-C restores the
  terminal.
- `GET /api/verse/fleet/view` - `handleFleetViewApi`
  (`src/core/verse/fleet-view-api.ts`), the `fleet-view` workbench family
  (`workbench-types.ts`), served from `getCachedFleetView`
  (`src/core/web/fleet-status-cache.ts`, 2 s TTL). GET only; every other
  method is a 405 and the route never takes a body.
- The remote page: `/api/verse/fleet/view` is on the gateway's read
  allowlist (`remote-gateway-policy.ts`); the mobile Fleet screen reads it
  through `fleetViewQuery` (`surface-data.ts`) and renders running agents
  and per-account `Meter` bars.
- `--json` and the route both emit the schema in
  `schema/fleet-view.v1.schema.json`.

## The aggregate (`src/core/fleet/view.ts`)

`buildFleetView(options): FleetView` - pure file/host reads; never writes,
never throws; every source degrades independently and reports its state in
`sources` (`ok|partial|missing|invalid|unsafe`).

- **Queue** (`src/core/fleet/router-queue.ts`): bounded reads of
  `~/.ashlr-runs/queue/{jobs.jsonl,status.json}` (`$ASHLR_RUNS_DIR`
  relocates the root). Schema-v1 rows only; unsafe files (non-regular,
  symlinked, oversized) and malformed content are refused, not parsed.
  The `status.json` overlay applies only while its `jobsSha256` binds the
  exact jobs bytes read; a mismatch keeps the log rows and marks the
  snapshot `partial`.
- **Accounts**: `resource.v1` (`$ASHLR_RESOURCE_PATH` /
  `<runs>/resource.json`) wins once the usage source lands; the manual
  `<runs>/fleet.json` (`$PHANTOM_FLEET_PATH`) readings+windows feed the
  bars until then. Two increasing readings inside one window give a
  measured burn %/h and projected exhaustion; weekly recurrences follow
  the configured timezone through DST.
- **Pause**: the same `~/.ashlr/KILL` sentinel `fleet.v1` reads.
- **Host**: memory via `os`; swap via `sysctl vm.swapusage` (macOS) or
  `/proc/meminfo` (Linux); absent on other platforms.

## Field shape (see the schema file for the binding version)

`FleetView`: `schema:"fleet-view.v1"`, `generatedAt`, `readOnly:true`,
`pause{state,reason}`, `host{state,memory*,swap*}`, `queue{state,depth,
running,jobs,byLane[]}`, `agents[]{id,lane,account,tier,repo,title,
startedAt,elapsedSeconds,tokens}`, `accounts[]{id,lanes,sharedWith,source,
usedPct,remainingPct,credits,resetAt,windowStart,burnPctPerHour,
runwayHours,projectedPct,idealPct,readingAt,ageSeconds}`,
`throughput{completedJobs,merged,mergeRate,reverted,knownTokens,
tokenSamples,recentMerged[]}`, `impact{total,samples,perLane[]}`,
`lanes[]{lane,account,tier,queued,running,tokens,agents[]}`,
`sources{jobs,status{applied,hashMatched},resources{kind,state,detail}}`.

## Verification

`test/fleet-view.test.ts` over `test/fixtures/fleet-view/`: the hash-bound
overlay contract, malformed-row drops, a golden `buildFleetView`
projection, a golden TUI frame, the schema coverage test, CLI dispatch and
flags, the remote route's read classification + mutation denial +
no-credentials payload, and the cache's TTL. Run it with
`npx vitest run test/fleet-view.test.ts`.
