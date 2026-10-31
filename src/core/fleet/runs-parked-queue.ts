/** Read-only, bounded projection of dispatchd's queue and precheck log. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseReadyTsv } from './lane-console.js';
import { scrubSecrets } from '../util/scrub.js';

export const VERSE_FLEET_LIVE_QUEUE_PATH = '/api/verse/fleet/live/queue';
export interface ParkedGroup { reason: string; lane: string | null; count: number; jobs: string[] }
export interface PrecheckSkip { at: string; job: string; code: string; reason: string }
type Source = 'healthy' | 'missing' | 'degraded';
export interface FleetQueueV1 {
  v: 1; generatedAt: string;
  sources: Record<'ready' | 'skips', Source>;
  total: number; ready: number; parked: number; malformed: number;
  byLane: Array<{ lane: string; ready: number; parked: number }>;
  groups: ParkedGroup[];
  skips: PrecheckSkip[];
  skipsLast24h: number | null;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PARKED = /^PARKED-([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9][A-Za-z0-9._@-]{0,63}))?$/i;
const MAX_READY = 2 * 1024 * 1024;
const MAX_SKIPS = 256 * 1024;
// eslint-disable-next-line no-control-regex -- public fields must not carry control bytes.
const UNSAFE_PUBLIC_FIELD = /[/\\\x00-\x1f\x7f]/;

export function parseParkedState(state: string): { parked: boolean; reason: string | null; lane: string | null } {
  const match = PARKED.exec(state);
  return match ? { parked: true, reason: match[1]!.toUpperCase(), lane: match[2] ?? null }
    : { parked: false, reason: null, lane: null };
}

function boundedLimit(limit?: number): number {
  return Number.isNaN(limit) ? 25 : Math.min(200, Math.max(1, Math.floor(limit ?? 25)));
}

/** Parse local wall time and render its actual offset, including DST. */
function localTimestamp(raw: string): { at: string; ms: number } {
  const match = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(raw);
  if (match) {
    const [, y, m, d, h, min, s] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s));
    if (date.getFullYear() === Number(y) && date.getMonth() === Number(m) - 1 && date.getDate() === Number(d) &&
        date.getHours() === Number(h) && date.getMinutes() === Number(min) && date.getSeconds() === Number(s)) {
      const offset = -date.getTimezoneOffset();
      const sign = offset >= 0 ? '+' : '-';
      const pad = (n: number) => String(n).padStart(2, '0');
      return { at: `${y}-${m}-${d}T${h}:${min}:${s}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`, ms: date.getTime() };
    }
  }
  return { at: raw, ms: Number.NaN };
}

function parseSkips(text: string, nowMs: number, limit?: number): { skips: PrecheckSkip[]; last24h: number; dropped: number } {
  const rows: Array<{ value: PrecheckSkip; ms: number; order: number }> = [];
  let dropped = 0;
  let last24h = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.replace(/\r$/, '').split('\t');
    const [at, job, code, reason] = cells;
    // No paths or control characters may escape through any public field.
    if (cells.length !== 4 || !at || !job || !JOB_ID.test(job) || !code || !reason ||
        [at, code, reason].some((cell) => cell.length > 400 || UNSAFE_PUBLIC_FIELD.test(cell))) {
      dropped++;
      continue;
    }
    const timestamp = localTimestamp(at);
    if (timestamp.ms <= nowMs && timestamp.ms >= nowMs - 24 * 60 * 60 * 1000) last24h++;
    rows.push({ value: { at: scrubSecrets(timestamp.at), job, code: scrubSecrets(code), reason: scrubSecrets(reason) }, ms: timestamp.ms, order: rows.length });
  }
  rows.sort((a, b) => (Number.isFinite(b.ms) ? b.ms : -Infinity) - (Number.isFinite(a.ms) ? a.ms : -Infinity) || b.order - a.order);
  return { skips: rows.slice(0, boundedLimit(limit)).map((row) => row.value), last24h, dropped };
}

export function parsePrecheckSkips(text: string, nowMs: number, limit?: number): { skips: PrecheckSkip[]; last24h: number } {
  const { skips, last24h } = parseSkips(text, nowMs, limit);
  return { skips, last24h };
}

async function readSource(path: string, max: number, tail: boolean): Promise<{ state: Source; text: string }> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile()) throw new Error('invalid source');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || (!tail && info.size > max)) throw new Error('invalid source');
    const start = tail ? Math.max(0, info.size - max) : 0;
    const buffer = Buffer.alloc(Math.min(info.size, max));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, start + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    let text = buffer.subarray(0, length).toString('utf8');
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { state: 'healthy', text };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', text: '' };
  } finally { await file?.close().catch(() => undefined); }
}

export async function readFleetQueue(opts: { runsDir?: string; now?: () => number; limit?: number } = {}): Promise<FleetQueueV1> {
  const now = (opts.now ?? Date.now)();
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const [readySource, skipsSource] = await Promise.all([
    readSource(join(root, 'queue', 'ready.tsv'), MAX_READY, false),
    readSource(join(root, 'queue', 'precheck-skips.tsv'), MAX_SKIPS, true),
  ]);
  // The shared parser recognizes READY but not PARKED as a positional status.
  // Retain original suffix casing, which the shared parser otherwise uppercases.
  const originalStates = new Map<string, string>();
  let hasHeader = false;
  const prepared = readySource.text.split('\n').map((line) => {
    const cells = line.split('\t');
    if (!hasHeader && cells.length >= 2 && cells.every((cell) => /^(?:id|job|jobid|task|name|status|state|pool|lane|account|repo|repository|project|tier|priority|pri|title|summary|at|ts|time|timestamp|updated|updatedat|createdat|landedat|mergedat|completedat)$/i.test(cell.trim())) &&
        cells.some((cell) => /^(?:status|state|pool|lane|account)$/i.test(cell.trim()))) hasHeader = true;
    for (const cell of cells) {
      const value = cell.trim().replace(/^(?:status|state)=/i, '');
      if (PARKED.test(value)) originalStates.set(value.toUpperCase(), value);
    }
    if (!hasHeader && PARKED.test(cells[0]?.trim() ?? '')) cells[0] = `status=${cells[0]!.trim()}`;
    return cells.join('\t');
  }).join('\n');
  const parsed = parseReadyTsv(prepared);
  const lanes = new Map<string, { lane: string; ready: number; parked: number }>();
  const groups = new Map<string, ParkedGroup>();
  let ready = 0;
  let parked = 0;
  let malformed = parsed.dropped;
  for (const row of parsed.rows) {
    const state = parseParkedState(originalStates.get(row.status) ?? row.status);
    if (!row.id || !JOB_ID.test(row.id) || (row.status !== 'READY' && !state.parked)) { malformed++; continue; }
    const lane = state.lane ?? row.pool;
    const counts = lanes.get(lane) ?? { lane, ready: 0, parked: 0 };
    lanes.set(lane, counts);
    if (!state.parked) { ready++; counts.ready++; continue; }
    parked++; counts.parked++;
    const reason = state.reason!;
    const key = `${reason}\0${lane}`;
    const group = groups.get(key) ?? { reason, lane, count: 0, jobs: [] };
    group.count++;
    group.jobs.push(row.id);
    groups.set(key, group);
  }
  if (malformed) readySource.state = 'degraded';
  const skips = parseSkips(skipsSource.text, now, opts.limit);
  if (skips.dropped) skipsSource.state = 'degraded';
  return {
    v: 1, generatedAt: new Date(now).toISOString(), sources: { ready: readySource.state, skips: skipsSource.state },
    total: ready + parked, ready, parked, malformed,
    byLane: [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane)),
    groups: [...groups.values()].map((group) => ({ ...group, jobs: group.jobs.sort().slice(0, 8) }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason) || (a.lane ?? '').localeCompare(b.lane ?? '')),
    skips: skips.skips, skipsLast24h: skipsSource.state === 'degraded' && !skipsSource.text ? null : skips.last24h,
  };
}
