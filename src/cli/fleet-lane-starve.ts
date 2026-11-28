import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { diskGuardedJobIds, findStarvedLanes, type StarvedLane } from '../core/fleet/lane-starve.js';

export { DISKGUARD_SUFFIX, FILLER_ID, diskGuardedJobIds, findStarvedLanes, type StarvedLane, type StarvedLanes } from '../core/fleet/lane-starve.js';

export const FLEET_LANE_STARVE_SCHEMA = 'fleet.lane-starve.v1';

export interface LaneStarveReport {
  schema: typeof FLEET_LANE_STARVE_SCHEMA;
  readOnly: true;
  filler_hold: boolean;
  /** Lane-open ready rows any lane may take; null when ready.tsv is absent. */
  open_rows: number | null;
  /** Market-evaluated ready rows carrying the dispatcher's .diskguard mark; null when queue/run cannot be listed. */
  disk_guarded_rows: number | null;
  lanes: StarvedLane[];
}

const USAGE = `Usage: ashlr fleet lane-starve [--json]
List lanes running below their launch target (the configured target tightened by the controller's effective_target shed) with work queued, and split each lane's queue/ready.tsv rows into filler and real. Dispatcher rows count toward the lane the work market's hint resolves to; lane-open rows are shared supply reported once. When the market inputs (queue/slots.json, models.json, queue/budget-overrides.json, queue/adaptive.json, HOLD) are readable, each lane also reports the work-market reason codes its own ready rows are blocked by; blocked and scored stay null when they are not. Each lane also counts its market-evaluated ready rows carrying the dispatcher's .diskguard mark in queue/run/ — jobs its disk reuse-only gate deferred before market selection and has not launched since (the mark clears on launch); diskguarded and disk_guarded_rows stay null when the directory cannot be listed. Says when queue/FILLER_HOLD exists. Read-only.
Parked rows are not runnable work and are not counted.
Lane alerts are suppressed when the dispatcher is paused or fleet admission is closed.
Reads ~/.ashlr-runs (override with ASHLR_RUNS_DIR). Exit 1 when any lane is starved.`;

export interface LaneStarveIo {
  /** Returns file text, or null when the file does not exist. */
  read: (path: string, maxBytes?: number) => Promise<string | null>;
  /** Returns directory entry names, or null when the directory cannot be listed. */
  list?: (dir: string) => Promise<string[] | null>;
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
  async list(dir) {
    try {
      return await readdir(dir);
    } catch {
      return null;
    }
  },
};

/** One plain clause for a lane's disk-guarded ready rows; unknown when queue/run cannot be listed. */
function diskguardedText(l: StarvedLane): string {
  return l.diskguarded === null ? 'disk-guard unknown' : `disk-guarded ${l.diskguarded}`;
}

/** One plain clause for a lane's blocked reason codes, mirroring fleet unfed's top-three tally. */
function blockedText(l: StarvedLane): string {
  if (l.blocked === null) return 'blocked unknown';
  if (l.scored === 0) return 'no market rows scored';
  const top = Object.entries(l.blocked)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([code, n]) => `${code} ${n}`)
    .join(', ');
  return `blocked ${top}`;
}

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
  const root = process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs');
  const queue = join(root, 'queue');
  let report: LaneStarveReport;
  try {
    // Market inputs are optional diagnostics: an unreadable or over-bound
    // file degrades that lane's blocked codes to null, never fails the read.
    const optional = (path: string) => io.read(path).catch(() => null);
    const [status, ready, routerQueue, hold, slots, models, budget, adaptive, operatorHold, runEntries] = await Promise.all([
      io.read(join(queue, 'status.json')),
      io.read(join(queue, 'ready.tsv')),
      io.read(join(queue, 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES),
      io.read(join(queue, 'FILLER_HOLD')),
      optional(join(queue, 'slots.json')),
      optional(join(root, 'models.json')),
      optional(join(queue, 'budget-overrides.json')),
      optional(join(queue, 'adaptive.json')),
      optional(join(root, 'HOLD')),
      // The .diskguard marks are optional diagnostics like the market
      // inputs: an unlistable queue/run degrades the counts to null.
      io.list ? io.list(join(queue, 'run')).catch(() => null) : Promise.resolve(null),
    ]);
    if (status === null) throw new Error('no status');
    const { lanes, openRows, diskGuardedRows } = findStarvedLanes(status, ready, routerQueue, Date.now(), {
      slots, models, budget, adaptive, hold: operatorHold,
    }, runEntries === null ? null : diskGuardedJobIds(runEntries));
    report = {
      schema: FLEET_LANE_STARVE_SCHEMA,
      readOnly: true,
      filler_hold: hold !== null,
      open_rows: openRows,
      disk_guarded_rows: diskGuardedRows,
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
      console.log(`${l.lane}: ${l.running}/${l.target} running, ${l.queued} queued; ready ${ready}; ${blockedText(l)}; ${diskguardedText(l)}`);
    }
    if (report.lanes.length === 0) console.log('No starved lanes.');
    if (report.open_rows !== null && report.open_rows > 0) {
      console.log(`${report.open_rows} lane-open row(s) can run on any lane.`);
    }
    if (report.disk_guarded_rows !== null && report.disk_guarded_rows > 0) {
      console.log(`Disk guard: ${report.disk_guarded_rows} waiting row(s) carry queue/run/*.diskguard — dispatchd's mark for jobs its disk reuse-only gate deferred before market selection; the mark clears when the job launches.`);
    }
    if (report.filler_hold) console.log('FILLER_HOLD is set: filler is held.');
  }
  return report.lanes.length > 0 ? 1 : 0;
}
