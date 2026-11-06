import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { count, exact, identifier, record, refuse, timestamp } from './contract.js';

export interface GrokUltraWindow { start: string; end: string; cap: number; used: number }
export interface GrokUltraSnapshot {
  schema: 'grok-ultra-budget.v1';
  pool: 'grok-ultra';
  observed_at: string;
  expires_at: string;
  not_before: string;
  day: GrokUltraWindow;
  week: GrokUltraWindow;
}
interface Reservation { id: string; at: string }
export async function privateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) refuse('absolute-state-path-required');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== path) refuse('unsafe-state-directory');
}
export async function readJson(path: string, maxBytes = 1_048_576): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || stat.nlink !== 1) refuse('invalid-state-file');
    const data = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > maxBytes) refuse('oversized-state-file');
    try { return JSON.parse(data.subarray(0, bytesRead).toString('utf8')); }
    catch { refuse('invalid-state-json'); }
  } finally { await file.close(); }
}
function windowValid(value: unknown, now: number, duration: number): value is GrokUltraWindow {
  return record(value) && exact(value, ['start', 'end', 'cap', 'used']) && timestamp(value.start) && timestamp(value.end) &&
    Date.parse(value.start) <= now && now < Date.parse(value.end) &&
    Date.parse(value.end) - Date.parse(value.start) === duration && count(value.cap) && count(value.used);
}
export function parseSnapshot(value: unknown, now: number): GrokUltraSnapshot {
  if (!record(value) || !exact(value, ['schema', 'pool', 'observed_at', 'expires_at', 'not_before', 'day', 'week']) ||
      value.schema !== 'grok-ultra-budget.v1' || value.pool !== 'grok-ultra' ||
      !timestamp(value.observed_at) || !timestamp(value.expires_at) || !timestamp(value.not_before) ||
      Date.parse(value.observed_at) > now || now - Date.parse(value.observed_at) > 300_000 ||
      Date.parse(value.expires_at) <= now || Date.parse(value.expires_at) - Date.parse(value.observed_at) > 300_000 ||
      !windowValid(value.day, now, 86_400_000) || !windowValid(value.week, now, 604_800_000)) refuse('ledger-unavailable');
  if (Date.parse(value.not_before) > now) refuse('ledger-paced');
  return value as unknown as GrokUltraSnapshot;
}

/** Durable reservation before network I/O. Failures retain their charge: a timeout
 * cannot prove the routine did not run. No automatic stale-lock reclamation. */
export async function reserveTask(root: string, id: string, now: number,
  readBudget: () => Promise<unknown>, caps: { day: number; week: number }): Promise<void> {
  if (!identifier(id) || !Number.isFinite(now) || !count(caps.day) || !count(caps.week)) refuse('invalid-admission');
  await privateDirectory(root);
  const lock = join(root, 'reservation.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { refuse('ledger-busy'); }
  try {
    let observation: unknown;
    try { observation = await readBudget(); } catch { refuse('ledger-unavailable'); }
    const budget = parseSnapshot(observation, now);
    const path = join(root, 'reservations.json');
    let rows: Reservation[] = [];
    try {
      const data = await readJson(path);
      if (!Array.isArray(data) || !data.every(row => record(row) && exact(row, ['id', 'at']) &&
          identifier(row.id) && timestamp(row.at) && Date.parse(row.at) <= now) ||
          new Set(data.map(row => row.id)).size !== data.length) refuse('corrupt-reservations');
      rows = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (rows.some(row => row.id === id)) refuse('duplicate-task');
    for (const key of ['day', 'week'] as const) {
      const window = budget[key];
      const local = rows.filter(row => Date.parse(row.at) >= Date.parse(window.start)).length;
      if (local + window.used >= Math.min(caps[key], window.cap)) refuse(`${key}-cap`);
    }
    // Bound state without forgetting IDs and accidentally making replay billable.
    if (rows.length >= 4096) refuse('reservation-store-full');
    rows.push({ id, at: new Date(now).toISOString() });
    const temporary = join(root, 'reservations.next');
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(rows)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(root, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rmdir(lock); }
}
