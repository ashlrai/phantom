import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FILLER_ID } from './fleet-lane-starve.js';

const SCHEMA = 'fleet.launchable.v1';
const MAX_BYTES = 8 * 1024 * 1024;
const USAGE = `Usage: ashlr fleet launchable [--json]
Count ready jobs that can start per lane and compare them with free slots.
Reads ~/.ashlr-runs/queue (override with ASHLR_RUNS_DIR). Exit 1 if any lane has more free slots than launchable jobs.`;

type Lane = { lane: string; running: number; target: number; free: number; launchable: number };
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
      lanes.set(lane, { lane, running: value.running, target: value.target, free: Math.max(0, value.target - value.running), launchable: 0 });
    }
    const excluded = new Set(skipped.split('\n').flatMap(line => {
      const cols = line.split('\t');
      return cols[1] && (cols[2]?.trim() === 'drop' || cols[2]?.trim() === 'defer') ? [cols[1].trim()] : [];
    }));
    for (const line of ready.split('\n')) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const cols = line.split('\t');
      const id = cols[0]?.trim() ?? '';
      const lane = cols[2]?.trim() ?? '';
      const prompt = cols[4]?.trim() ?? '';
      const entry = lanes.get(lane);
      if (!id || !entry || lane.startsWith('PARKED') || !prompt || excluded.has(id) || (hold && FILLER_ID.test(id))) continue;
      if (await exists(prompt, true)) entry.launchable++;
    }
    const rows = [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane));
    if (json) console.log(JSON.stringify({ schema: SCHEMA, readOnly: true, fillerHold: hold, lanes: rows }));
    else console.log(rows.map(l => `${l.lane}: ${l.launchable} launchable, ${l.free} free slots (${l.running}/${l.target} running)`).join('\n') || 'No lanes.');
    return rows.some(l => l.free > l.launchable) ? 1 : 0;
  } catch {
    const error = 'Cannot read queue data or valid lane status.';
    console.log(json ? JSON.stringify({ schema: SCHEMA, readOnly: true, error }) : error);
    return 2;
  }
}
