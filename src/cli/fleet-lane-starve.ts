import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findStarvedLanes, type StarvedLane } from '../core/fleet/lane-starve.js';

export { FILLER_ID, findStarvedLanes, type StarvedLane, type StarvedLanes } from '../core/fleet/lane-starve.js';

export const FLEET_LANE_STARVE_SCHEMA = 'fleet.lane-starve.v1';

export interface LaneStarveReport {
  schema: typeof FLEET_LANE_STARVE_SCHEMA;
  readOnly: true;
  filler_hold: boolean;
  /** Lane-open ready rows any lane may take; null when ready.tsv is absent. */
  open_rows: number | null;
  lanes: StarvedLane[];
}

const USAGE = `Usage: ashlr fleet lane-starve [--json]
List lanes running below their launch target (the configured target tightened by the controller's effective_target shed) with work queued, and split each lane's queue/ready.tsv rows into filler and real. Dispatcher rows count toward the lane the work market's hint resolves to; lane-open rows are shared supply reported once. Says when queue/FILLER_HOLD exists. Read-only.
Parked rows are not runnable work and are not counted.
Reads ~/.ashlr-runs (override with ASHLR_RUNS_DIR). Exit 1 when any lane is starved.`;

export interface LaneStarveIo {
  /** Returns file text, or null when the file does not exist. */
  read: (path: string, maxBytes?: number) => Promise<string | null>;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** router-queue.md is append-mostly Markdown history; give it a wider bound. */
const ROUTER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

const defaultIo: LaneStarveIo = {
  async read(path, maxBytes = MAX_FILE_BYTES) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > maxBytes) throw new Error('unreadable or over read bound');
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
};

/** Read-only: never changes holds or launches work. */
export async function cmdFleetLaneStarve(args: string[], io: LaneStarveIo = defaultIo): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const json = args[0] === '--json';
  const queue = join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'queue');
  let report: LaneStarveReport;
  try {
    const [status, ready, routerQueue, hold] = await Promise.all([
      io.read(join(queue, 'status.json')),
      io.read(join(queue, 'ready.tsv')),
      io.read(join(queue, 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES),
      io.read(join(queue, 'FILLER_HOLD')),
    ]);
    if (status === null) throw new Error('no status');
    const { lanes, openRows } = findStarvedLanes(status, ready, routerQueue, Date.now());
    report = {
      schema: FLEET_LANE_STARVE_SCHEMA,
      readOnly: true,
      filler_hold: hold !== null,
      open_rows: openRows,
      lanes,
    };
  } catch {
    const error = 'Cannot read current lane status. Expected lane counts and a last_tick at most 60 seconds old in queue/status.json.';
    console.log(json ? JSON.stringify({ schema: FLEET_LANE_STARVE_SCHEMA, readOnly: true, error }) : error);
    return 2;
  }
  if (json) console.log(JSON.stringify(report));
  else {
    for (const l of report.lanes) {
      const ready = l.ready === null ? 'unknown' : `${l.ready} = ${l.filler} filler + ${l.real} real`;
      console.log(`${l.lane}: ${l.running}/${l.target} running, ${l.queued} queued; ready ${ready}`);
    }
    if (report.lanes.length === 0) console.log('No starved lanes.');
    if (report.open_rows !== null && report.open_rows > 0) {
      console.log(`${report.open_rows} lane-open row(s) can run on any lane.`);
    }
    if (report.filler_hold) console.log('FILLER_HOLD is set: filler is held.');
  }
  return report.lanes.length > 0 ? 1 : 0;
}
