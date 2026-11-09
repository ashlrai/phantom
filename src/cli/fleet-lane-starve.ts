import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FLEET_LANE_STARVE_SCHEMA = 'fleet.lane-starve.v1';

/** Filler ids end in A, six or more digits, then Q8. */
export const FILLER_ID = /A\d{6,}Q8$/;

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface StarvedLane {
  lane: string;
  running: number;
  target: number;
  queued: number;
  /** Rows in queue/ready.tsv for this lane. */
  ready: number;
  filler: number;
  real: number;
}

export interface LaneStarveReport {
  schema: typeof FLEET_LANE_STARVE_SCHEMA;
  readOnly: true;
  filler_hold: boolean;
  lanes: StarvedLane[];
}

const USAGE = `Usage: ashlr fleet lane-starve [--json]
List lanes running below target with work queued, and split each lane's queue/ready.tsv rows into filler and real. Says when queue/FILLER_HOLD exists. Read-only.
Reads ~/.ashlr-runs (override with ASHLR_RUNS_DIR). Exit 1 when any lane is starved.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Pure: starved lanes from status.json text and ready.tsv text ('' when absent). */
export function findStarvedLanes(statusJson: string, readyTsv: string): StarvedLane[] {
  const data: unknown = JSON.parse(statusJson);
  if (!isRecord(data) || !isRecord(data.lanes)) throw new Error('invalid status');
  const split = new Map<string, { filler: number; real: number }>();
  for (const line of readyTsv.split('\n')) {
    const cols = line.split('\t');
    const id = cols[0]?.trim() ?? '';
    const lane = cols[2]?.trim();
    if (!id || !lane) continue;
    const entry = split.get(lane) ?? { filler: 0, real: 0 };
    entry[FILLER_ID.test(id) ? 'filler' : 'real']++;
    split.set(lane, entry);
  }
  const out: StarvedLane[] = [];
  for (const [lane, value] of Object.entries(data.lanes)) {
    if (!isRecord(value) || !count(value.running) || !count(value.target) || !count(value.queued)) {
      throw new Error('invalid lane');
    }
    if (value.running >= value.target || value.queued === 0) continue;
    const { filler, real } = split.get(lane) ?? { filler: 0, real: 0 };
    out.push({ lane, running: value.running, target: value.target, queued: value.queued, ready: filler + real, filler, real });
  }
  return out.sort((a, b) => a.lane.localeCompare(b.lane));
}

export interface LaneStarveIo {
  /** Returns file text, or null when the file does not exist. */
  read: (path: string) => Promise<string | null>;
}

const defaultIo: LaneStarveIo = {
  async read(path) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('unreadable or over read bound');
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
    const status = await io.read(join(queue, 'status.json'));
    if (status === null) throw new Error('no status');
    const ready = (await io.read(join(queue, 'ready.tsv'))) ?? '';
    const hold = (await io.read(join(queue, 'FILLER_HOLD'))) !== null;
    report = {
      schema: FLEET_LANE_STARVE_SCHEMA,
      readOnly: true,
      filler_hold: hold,
      lanes: findStarvedLanes(status, ready),
    };
  } catch {
    const error = 'Cannot read lane status. Expected lanes with running, target and queued in queue/status.json.';
    console.log(json ? JSON.stringify({ schema: FLEET_LANE_STARVE_SCHEMA, readOnly: true, error }) : error);
    return 2;
  }
  if (json) console.log(JSON.stringify(report));
  else {
    for (const l of report.lanes) {
      console.log(`${l.lane}: ${l.running}/${l.target} running, ${l.queued} queued; ready ${l.ready} = ${l.filler} filler + ${l.real} real`);
    }
    if (report.lanes.length === 0) console.log('No starved lanes.');
    if (report.filler_hold) console.log('FILLER_HOLD is set: filler is held.');
  }
  return report.lanes.length > 0 ? 1 : 0;
}
