import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planLaunchable } from '../core/fleet/launchable.js';

const SCHEMA = 'fleet.launchable.v1';
const MAX_BYTES = 8 * 1024 * 1024;
/** router-queue.md is append-mostly Markdown history; give it a wider bound. */
const ROUTER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
const USAGE = `Usage: ashlr fleet launchable [--json]
Count ready jobs that can start per lane and compare them with free slots.
Lane-open ready rows are shared supply any lane may take. Reads
~/.ashlr-runs/queue (override with ASHLR_RUNS_DIR). Exit 1 if any lane has
more free slots than launchable jobs plus lane-open supply.`;

async function read(path: string, optional = false, maxBytes = MAX_BYTES): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid file');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function exists(path: string, file = false): Promise<boolean> {
  try {
    const info = await stat(path);
    return !file || info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Read-only: never changes holds or launches work. */
export async function cmdFleetLaunchable(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(USAGE); return 2; }
  const json = args.includes('--json');
  try {
    const queue = join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'queue');
    const [statusText, ready, skipped, routerQueue, hold] = await Promise.all([
      read(join(queue, 'status.json')), read(join(queue, 'ready.tsv'), true),
      read(join(queue, 'skipped-empty.tsv'), true),
      read(join(queue, 'router-queue.md'), true, ROUTER_QUEUE_MAX_BYTES),
      exists(join(queue, 'FILLER_HOLD')),
    ]);
    const plan = await planLaunchable(
      { statusJson: statusText, readyTsv: ready, routerQueue, skippedEmpty: skipped },
      { fillerHold: hold, promptExists: path => exists(path, true) },
    );
    const rows = plan.lanes;
    const openRows = plan.openRows;
    if (json) console.log(JSON.stringify({ schema: SCHEMA, readOnly: true, fillerHold: hold, openRows, lanes: rows }));
    else {
      console.log(rows.map(l => `${l.lane}: ${l.launchable} launchable, ${l.free} free slots (${l.running}/${l.target} running)`).join('\n') || 'No lanes.');
      if (openRows > 0) console.log(`${openRows} lane-open row(s) can start on any lane.`);
    }
    // Lane-open rows are shared supply the market may place on any lane, so a
    // lane is under-supplied only when even all of them could not fill it.
    return rows.some(l => l.free > l.launchable + openRows) ? 1 : 0;
  } catch {
    const error = 'Cannot read queue data or valid lane status.';
    console.log(json ? JSON.stringify({ schema: SCHEMA, readOnly: true, error }) : error);
    return 2;
  }
}
