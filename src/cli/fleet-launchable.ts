import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { laneLaunchTarget } from '../core/fleet/lane-launch-target.js';
import { FILLER_ID, isParkedReadyRow } from '../core/fleet/lane-starve.js';
import { readySpecCell, resolveReadyMarketRow } from '../core/fleet/unfed-market.js';

const SCHEMA = 'fleet.launchable.v1';
const MAX_BYTES = 8 * 1024 * 1024;
const USAGE = `Usage: ashlr fleet launchable [--json]
Count ready jobs that can start per lane and compare them with free slots.
Lane-open ready rows are shared supply any lane may take. Reads
~/.ashlr-runs/queue (override with ASHLR_RUNS_DIR). Exit 1 if any lane has
more free slots than launchable jobs plus lane-open supply.`;

type Lane = { lane: string; running: number; target: number; free: number; launchable: number };
// target is the launch target: the configured target tightened by the controller's effective_target shed.
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

async function read(path: string, optional = false): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid file');
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

export async function cmdFleetLaunchable(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(USAGE); return 2; }
  const json = args.includes('--json');
  try {
    const queue = join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'queue');
    const [statusText, ready, skipped, hold] = await Promise.all([
      read(join(queue, 'status.json')), read(join(queue, 'ready.tsv'), true),
      read(join(queue, 'skipped-empty.tsv'), true), exists(join(queue, 'FILLER_HOLD')),
    ]);
    const status: unknown = JSON.parse(statusText);
    if (!record(status) || !record(status.lanes)) throw new Error('Invalid status');
    const lanes = new Map<string, Lane>();
    for (const [lane, value] of Object.entries(status.lanes)) {
      if (!record(value) || !count(value.running) || !count(value.target)) throw new Error('Invalid lane');
      // Free slots count against the launch ceiling: a shed lane has no phantom room.
      const target = laneLaunchTarget(value.target, count(value.effective_target) ? value.effective_target : null);
      lanes.set(lane, { lane, running: value.running, target, free: Math.max(0, target - value.running), launchable: 0 });
    }
    const excluded = new Set(skipped.split('\n').flatMap(line => {
      const cols = line.split('\t');
      return cols[1] && (cols[2]?.trim() === 'drop' || cols[2]?.trim() === 'defer') ? [cols[1].trim()] : [];
    }));
    let openRows = 0;
    for (const line of ready.split('\n')) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const cols = line.split('\t').map(cell => cell.trim());
      const id = cols[0] ?? '';
      const prompt = cols[4] ?? '';
      if (!id || !prompt || isParkedReadyRow(cols) || excluded.has(id) || (hold && FILLER_ID.test(id))) continue;
      // The market resolves the effective lane hint from the requirements cell:
      // preferred_lane wins over the lane column, and an explicit null — or an
      // empty lane cell — is lane-open supply any lane may take. A row the
      // market would reject is dead work, never launchable.
      const spec = cols.length > 5 ? readySpecCell(cols[5]) : null;
      if (spec === 'invalid') continue;
      const resolved = resolveReadyMarketRow(cols, spec ?? {});
      if (resolved === null) continue;
      if (resolved.hint === null) {
        if (await exists(prompt, true)) openRows++;
        continue;
      }
      const entry = lanes.get(resolved.hint);
      if (entry === undefined) continue;
      if (await exists(prompt, true)) entry.launchable++;
    }
    const rows = [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane));
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
