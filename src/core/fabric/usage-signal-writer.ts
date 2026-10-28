import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory } from '../universe/artifacts.js';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';

export const USAGE_POOLS = ['grok-ultra', 'codex-cmp', 'codex-personal', 'claude-max', 'terra'] as const;
export type UsagePool = typeof USAGE_POOLS[number];
export const USAGE_EVENTS = ['dispatch-start', 'pr-merge', '429', 'limit-message', 'manual-reading'] as const;
export type UsageEvent = typeof USAGE_EVENTS[number];
export const USAGE_DEBOUNCE_MS = 30 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;

export interface UsageCutSignal {
  pool: 'grok-ultra'; kind: 'cut'; pctUsed: number; fetchedAt: string;
}
export interface UsageReading {
  pool: UsagePool; pctUsed: number | null; resetAt: string | null; source: string; fetchedAt: string;
  writtenAt: string; event: UsageEvent; burnRatePctPerHour: number | null; projected100At: string | null;
  cutActive: boolean;
}
export interface UsageSignalOptions {
  directory: string; event: UsageEvent; pools?: readonly UsagePool[];
  readers?: Partial<Record<UsagePool, () => Promise<unknown>>>;
  now?: () => Date;
}
export interface UsageSignalResult {
  written: UsagePool[]; debounced: UsagePool[]; signals: UsageCutSignal[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
function percent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}
function source(pool: UsagePool): string { return pool === 'grok-ultra' ? 'grok-reader' : `${pool}-reader`; }

/** Fixed private store files only. No native profiles, auth files or provider payloads. */
function openPrivate(path: string, append = false): number {
  const fd = openSync(path, (append ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT : constants.O_RDONLY) |
    constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600) throw new Error();
    return fd;
  } catch { closeSync(fd); throw new Error('Usage store file is unsafe'); }
}
function readPrivate(path: string): string | null {
  let fd: number;
  try { fd = openPrivate(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const before = fstatSync(fd);
    if (before.size > MAX_BYTES) throw new Error('Usage store capacity reached');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('Usage store changed during read');
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Usage store changed during read');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { closeSync(fd); }
}

function checkedReading(value: unknown): value is UsageReading {
  if (!object(value)) return false;
  return USAGE_POOLS.includes(value.pool as UsagePool) && USAGE_EVENTS.includes(value.event as UsageEvent) &&
    (value.pctUsed === null || percent(value.pctUsed)) && (value.resetAt === null || timestamp(value.resetAt)) &&
    timestamp(value.fetchedAt) && timestamp(value.writtenAt) && value.source === source(value.pool as UsagePool) &&
    typeof value.cutActive === 'boolean' &&
    (value.burnRatePctPerHour === null || typeof value.burnRatePctPerHour === 'number' &&
      Number.isFinite(value.burnRatePctPerHour) && value.burnRatePctPerHour >= 0) &&
    (value.projected100At === null || timestamp(value.projected100At)) &&
    Object.keys(value).every(key => ['pool', 'pctUsed', 'resetAt', 'source', 'fetchedAt', 'writtenAt', 'event',
      'burnRatePctPerHour', 'projected100At', 'cutActive'].includes(key));
}

function journal(root: string): { latest: Partial<Record<UsagePool, UsageReading>>; cut: UsageCutSignal | null } {
  const raw = readPrivate(join(root, 'usage-readings.log'));
  const latest: Partial<Record<UsagePool, UsageReading>> = {};
  let cut: UsageCutSignal | null = null;
  if (!raw) return { latest, cut };
  // A torn append is unknown, never permission to repeat a reader/write.
  if (!raw.endsWith('\n')) throw new Error('Usage journal is incomplete');
  for (const line of raw.trimEnd().split('\n')) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new Error('Usage journal is invalid'); }
    if (!checkedReading(row)) throw new Error('Usage journal is invalid');
    if (latest[row.pool] && row.writtenAt < latest[row.pool]!.writtenAt) throw new Error('Usage journal moved backwards');
    latest[row.pool] = row;
    if (row.pool === 'grok-ultra') {
      if (!row.cutActive) cut = null;
      else if (row.pctUsed !== null) cut = { pool: row.pool, kind: 'cut', pctUsed: row.pctUsed, fetchedAt: row.fetchedAt };
    }
  }
  return { latest, cut };
}

function reading(pool: UsagePool, raw: unknown, previous: UsageReading | undefined,
  event: UsageEvent, now: string): UsageReading {
  const out: UsageReading = { pool, pctUsed: null, resetAt: null, source: source(pool), fetchedAt: now,
    writtenAt: now, event, burnRatePctPerHour: null, projected100At: null, cutActive: previous?.cutActive ?? false };
  // Select numeric/time fields only. Never propagate source text, errors or unknown keys.
  if (object(raw) && raw.pool === pool && (raw.pctUsed === null || percent(raw.pctUsed)) &&
    (raw.resetAt === null || timestamp(raw.resetAt)) && timestamp(raw.fetchedAt) &&
    Date.parse(raw.fetchedAt) <= Date.parse(now) && Date.parse(now) - Date.parse(raw.fetchedAt) < USAGE_DEBOUNCE_MS &&
    (raw.resetAt === null || Date.parse(raw.resetAt) > Date.parse(now))) {
    out.pctUsed = raw.pctUsed; out.resetAt = raw.resetAt; out.fetchedAt = raw.fetchedAt;
  }
  if (pool === 'grok-ultra' && out.pctUsed !== null) out.cutActive = out.pctUsed >= 80;
  const elapsed = previous ? (Date.parse(out.fetchedAt) - Date.parse(previous.fetchedAt)) / 3_600_000 : 0;
  if (out.pctUsed !== null && previous?.pctUsed !== null && previous?.pctUsed !== undefined &&
    out.resetAt !== null && out.resetAt === previous.resetAt && elapsed > 0 && out.pctUsed >= previous.pctUsed) {
    out.burnRatePctPerHour = (out.pctUsed - previous.pctUsed) / elapsed;
    if (out.pctUsed === 100) out.projected100At = out.fetchedAt;
    else if (out.burnRatePctPerHour > 0) {
      const projected = Date.parse(out.fetchedAt) + (100 - out.pctUsed) / out.burnRatePctPerHour * 3_600_000;
      // A reset ends this pool window before exhaustion; no false depletion alarm.
      if (projected < Date.parse(out.resetAt)) out.projected100At = new Date(projected).toISOString();
    }
  }
  return out;
}

const pending = new Map<string, Promise<unknown>>();
/** Leading-edge throttle: dropped events schedule no trailing read and no polling. */
export async function writeUsageSignal(options: UsageSignalOptions): Promise<UsageSignalResult> {
  if (!USAGE_EVENTS.includes(options.event) || options.pools?.some(pool => !USAGE_POOLS.includes(pool)) ||
    /(?:^|\/)\.codex(?:-2)?(?:\/|$)/.test(options.directory)) {
    throw new Error('Invalid usage signal');
  }
  const root = privateDirectory(options.directory);
  const previous = pending.get(root) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => writeLocked(root, options));
  pending.set(root, work);
  try { return await work; } finally { if (pending.get(root) === work) pending.delete(root); }
}

async function writeLocked(root: string, options: UsageSignalOptions): Promise<UsageSignalResult> {
  const acquired = acquireLocalStoreLockWithOutcome(join(root, 'usage-writer.lock'), 0,
    { anchorPath: root, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') throw new Error('Usage writer busy or unavailable; retry the event');
  const lock = acquired.lock;
  try {
    const now = (options.now ?? (() => new Date()))().toISOString();
    const history = journal(root); const latest = history.latest;
    const fleetRaw = readPrivate(join(root, 'fleet.json'));
    let fleet: Record<string, unknown> = {};
    if (fleetRaw !== null) {
      try { const value: unknown = JSON.parse(fleetRaw); if (!object(value)) throw new Error(); fleet = value; }
      catch { throw new Error('Usage fleet snapshot is invalid'); }
    }
    if (fleet.readings !== undefined && !object(fleet.readings) ||
      fleet.usageSignals !== undefined && !object(fleet.usageSignals)) throw new Error('Usage fleet snapshot is invalid');
    for (const pool of USAGE_POOLS) {
      const projected = (fleet.readings as Record<string, unknown> | undefined)?.[pool];
      // Losing/truncating the journal must not grant a fresh debounce window.
      if (checkedReading(projected) && (!latest[pool] || projected.writtenAt > latest[pool]!.writtenAt)) {
        throw new Error('Usage journal is missing acknowledged readings');
      }
    }
    const result: UsageSignalResult = { written: [], debounced: [], signals: [] };
    const rows: UsageReading[] = [];
    for (const pool of new Set(options.pools ?? USAGE_POOLS)) {
      const prior = latest[pool];
      // Backward wall-clock changes fail closed until time catches up.
      if (prior && Date.parse(now) - Date.parse(prior.writtenAt) < USAGE_DEBOUNCE_MS) {
        result.debounced.push(pool); continue;
      }
      let raw: unknown = null;
      try { raw = await options.readers?.[pool]?.(); } catch { /* Unknown; raw errors never escape. */ }
      const row = reading(pool, raw, prior, options.event, (options.now ?? (() => new Date()))().toISOString());
      latest[pool] = row; rows.push(row); result.written.push(pool);
      if (pool === 'grok-ultra' && row.cutActive && !prior?.cutActive && row.pctUsed !== null) {
        result.signals.push({ pool, kind: 'cut', pctUsed: row.pctUsed, fetchedAt: row.fetchedAt });
      }
      if (pool === 'grok-ultra') {
        if (!row.cutActive) history.cut = null;
        else if (row.pctUsed !== null) history.cut = { pool, kind: 'cut', pctUsed: row.pctUsed, fetchedAt: row.fetchedAt };
      }
    }
    if (!ownsLocalStoreLock(lock)) throw new Error('Usage writer lost lock');
    if (rows.length) {
      // Completion, rather than dispatch, anchors debounce for slow readers too.
      const writtenAt = (options.now ?? (() => new Date()))().toISOString();
      if (writtenAt < now) throw new Error('Usage writer clock moved backwards');
      for (const row of rows) row.writtenAt = writtenAt;
      const fd = openPrivate(join(root, 'usage-readings.log'), true);
      try {
        const bytes = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
        if (fstatSync(fd).size + bytes.length > MAX_BYTES) throw new Error('Usage journal capacity reached');
        let offset = 0;
        while (offset < bytes.length) {
          const count = writeSync(fd, bytes, offset, bytes.length - offset);
          if (count <= 0) throw new Error('Usage journal write failed');
          offset += count;
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    const readings = { ...(fleet.readings as Record<string, unknown> | undefined), ...latest };
    const usageSignals = { ...(fleet.usageSignals as Record<string, unknown> | undefined) };
    const grok = latest['grok-ultra'];
    if (grok?.cutActive && history.cut) usageSignals['grok-ultra'] = history.cut;
    else if (grok) delete usageSignals['grok-ultra'];
    const next = { ...fleet, readings, usageSignals };
    // Journal first: if interrupted, the next event repairs projection without rereading providers.
    if (rows.length || JSON.stringify(next) !== JSON.stringify(fleet)) {
      writePrivateFileAtomically(join(root, `.usage-${randomUUID()}.tmp`), join(root, 'fleet.json'),
        JSON.stringify(next, null, 2) + '\n', { anchorPath: root, label: 'Usage fleet snapshot' });
    }
    return result;
  } finally { releaseLocalStoreLock(lock); }
}
