/**
 * Compatibility entry point for the Fleet Board reader restored by PR #4957.
 * The canonical reader and wire contract now live in leader-journal.ts.
 * Keep callers on that implementation so validation and read bounds stay shared.
 */
export {
  FLEET_BOARD_SCHEMA,
  FLEET_BOARD_FILE,
  fleetBoardPath,
  defaultFleetBoardRunsDir,
  parseFleetBoard,
  readFleetBoard,
  fleetBoardDigest,
  fleetBoardResponse,
} from './leader-journal.js';
export type {
  FleetBoardLane,
  FleetBoardConflictSample,
  FleetBoardConflictTrend,
  FleetBoardNeedsMasonItem,
  FleetBoardNeedsMasonStatus,
  FleetBoardSourceState,
  FleetBoardV1,
  FleetBoardStatus,
  FleetBoardRead,
  FleetBoardResponse,
} from './leader-journal.js';
