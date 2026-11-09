import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseReadyTsv } from '../core/fleet/lane-console.js';

export const FLEET_ROUTE_PINS_SCHEMA = 'fleet.route-pins.v1';

export type RoutePinState = 'kept' | 'moved' | 'not-launched';

export interface RoutePinRow {
  id: string;
  state: RoutePinState;
  /** Lane the queue says the job should run in; null when the queue does not name one. */
  queued: string | null;
  /** Lane in queue/run/<id>.line column 3; null when the job has not launched. */
  launched: string | null;
}

export interface FleetRoutePinsReport {
  schema: typeof FLEET_ROUTE_PINS_SCHEMA;
  readOnly: true;
  pins: RoutePinRow[];
  kept: number;
  moved: number;
  notLaunched: number;
  /** kept / (kept + moved); null when nothing has launched yet. */
  keptRate: number | null;
}

/** Text of each source, or null when the file is absent. */
export interface FleetRoutePinsInput {
  pinned: string | null;
  readyTsv: string | null;
  routerQueue: string | null;
  /** Content of queue/run/<id>.line, or null when the job has not launched. */
  runLine(id: string): Promise<string | null>;
}

const USAGE = `Usage: ashlr fleet route-pins [--json]
For each id in queue/PINNED, compare its queued lane (ready.tsv, else router-queue.md pool=) with the lane it launched in (queue/run/<id>.line, column 3).
Prints kept, moved or not-launched per id and the kept rate. Read-only. ASHLR_RUNS_DIR overrides ~/.ashlr-runs.`;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Pure: classify every pinned id. Unreadable ids and blank lines are skipped. */
export async function routePins(input: FleetRoutePinsInput): Promise<FleetRoutePinsReport> {
  const queued = new Map<string, string>();
  // router-queue.md is the fallback, so ready.tsv entries are written last and win.
  for (const line of (input.routerQueue ?? '').split(/\r?\n/)) {
    const id = line.match(/^- \w+ (RQ-[A-Za-z0-9_-]+)(?=\s|$)/)?.[1];
    const pool = line.match(/(?:^|[\s,(])pool=([A-Za-z0-9_./-]+)(?=\s|[,;)]|$)/)?.[1];
    if (id && pool && !queued.has(id)) queued.set(id, pool);
  }
  for (const row of parseReadyTsv(input.readyTsv ?? '').rows) if (row.id) queued.set(row.id, row.pool);

  const ids = [...new Set((input.pinned ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => ID.test(l)))];
  const pins: RoutePinRow[] = [];
  for (const id of ids) {
    const text = await input.runLine(id);
    const launched = text === null ? null : text.split('\n')[0]!.split('\t')[2]?.trim() || null;
    const want = queued.get(id) ?? null;
    const state: RoutePinState = launched === null ? 'not-launched' : want === launched ? 'kept' : 'moved';
    pins.push({ id, state, queued: want, launched });
  }
  const count = (s: RoutePinState) => pins.filter(p => p.state === s).length;
  const kept = count('kept'), moved = count('moved');
  return {
    schema: FLEET_ROUTE_PINS_SCHEMA,
    readOnly: true,
    pins,
    kept,
    moved,
    notLaunched: count('not-launched'),
    keptRate: kept + moved === 0 ? null : Math.round((kept / (kept + moved)) * 1000) / 1000,
  };
}

const readOrNull = (path: string): Promise<string | null> =>
  readFile(path, 'utf8').then(text => text, (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });

export function fsRoutePinsInput(runsDir: string): FleetRoutePinsInput {
  const queue = join(runsDir, 'queue');
  return {
    pinned: null, readyTsv: null, routerQueue: null, // filled by cmdFleetRoutePins
    runLine: id => readOrNull(join(queue, 'run', `${id}.line`)),
  };
}

export async function cmdFleetRoutePins(args: string[], runsDir?: string): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const json = args[0] === '--json';
  const root = runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let report: FleetRoutePinsReport;
  try {
    const queue = join(root, 'queue');
    const [pinned, readyTsv, routerQueue] = await Promise.all(
      ['PINNED', 'ready.tsv', 'router-queue.md'].map(name => readOrNull(join(queue, name))));
    report = await routePins({ ...fsRoutePinsInput(root), pinned, readyTsv, routerQueue });
  } catch {
    const error = 'Route pins are unreadable.';
    console.log(json ? JSON.stringify({ schema: FLEET_ROUTE_PINS_SCHEMA, readOnly: true, error }) : error);
    return 2;
  }
  if (json) {
    console.log(JSON.stringify(report));
    return 0;
  }
  for (const pin of report.pins) {
    const detail = pin.state === 'moved' ? ` ${pin.queued ?? 'unknown'} -> ${pin.launched}` : pin.launched ? ` ${pin.launched}` : '';
    console.log(`${pin.id} ${pin.state}${detail}`);
  }
  if (report.pins.length === 0) console.log('No pinned jobs.');
  console.log(report.keptRate === null ? 'kept rate n/a' : `kept rate ${Math.round(report.keptRate * 100)}% (${report.kept}/${report.kept + report.moved})`);
  return 0;
}
