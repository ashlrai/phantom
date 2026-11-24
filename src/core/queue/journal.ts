import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { isQueueVisit, queueVisitKey, type QueueVisit } from './stats.js';

/** `$ASHLR_HOME/queue/visits.jsonl` (default `~/.ashlr/...`), resolved per call so a test HOME is honoured. */
export const queueJournalPath = (): string => {
  const configured = process.env['ASHLR_HOME'];
  const root = typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.ashlr');
  return join(root, 'queue', 'visits.jsonl');
};

/** Record metadata only: reuse the visit id at each transition; retries need a new id. */
export async function recordQueueVisit(visit: QueueVisit, path = queueJournalPath()): Promise<void> {
  if (!isQueueVisit(visit)) throw new Error('Invalid queue visit');
  const { id, station, pool, arrivedAt, startedAt, completedAt } = visit;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify({ id, station, pool, arrivedAt, startedAt, completedAt }) + '\n', { mode: 0o600 });
}

/**
 * Append many validated snapshots in one write — the daemon visit-sync
 * catch-up path, where a per-visit `recordQueueVisit` would mean one
 * open/close per row. Same line shape, validation and file mode; returns the
 * number appended (0 for an empty batch, which writes nothing).
 */
export async function appendQueueVisits(visits: readonly QueueVisit[], path = queueJournalPath()): Promise<number> {
  if (visits.length === 0) return 0;
  const lines = visits.map((visit) => {
    if (!isQueueVisit(visit)) throw new Error('Invalid queue visit');
    const { id, station, pool, arrivedAt, startedAt, completedAt } = visit;
    return JSON.stringify({ id, station, pool, arrivedAt, startedAt, completedAt });
  });
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  return lines.length;
}

export async function readQueueVisits(path = queueJournalPath()): Promise<QueueVisit[]> {
  let content: string;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Cannot read queue journal');
  }
  return content.split('\n').filter(line => line.trim()).map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid queue journal line ${index + 1}`); }
    if (!isQueueVisit(value)) throw new Error(`Invalid queue journal line ${index + 1}`);
    return value;
  });
}

/**
 * Byte cap that triggers a compaction rewrite. The journal is read whole by
 * `phm queue stats`, the dashboard-polled GET /api/queue/stats and every
 * visit-sync dedup pass, so an append-only file makes each of those reads
 * slower forever. Compaction keeps the file near the live evidence window
 * instead of every transition ever recorded.
 */
export const VISIT_JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Completed visits whose latest snapshot is older than this are dead
 * evidence: every stats window (1h/24h/7d defaults, and any realistic
 * manual --window) ends long before it, and a visit id is never reused, so
 * no producer can append a newer snapshot for it. Kept well past the
 * largest documented window so manual queries still see honest history.
 */
export const VISIT_JOURNAL_RECENT_MS = 30 * 24 * 60 * 60 * 1000;

export interface QueueJournalCompactionOptions {
  /** Epoch-ms clock for the retention cutoff (default: Date.now()). */
  now?: number;
  /**
   * Visit keys still derivable from the current evidence window (the jobs
   * ledger tail fold plus live READY rows). Their latest snapshots are
   * always kept: dropping one would let the next sync re-append it, so the
   * journal could never settle below the cap.
   */
  keepKeys?: ReadonlySet<string>;
  /** Byte cap that triggers the rewrite (default VISIT_JOURNAL_MAX_BYTES). */
  maxBytes?: number;
  /** Completed-visit retention horizon (default VISIT_JOURNAL_RECENT_MS). */
  recentMs?: number;
}

export interface QueueJournalCompaction {
  state: 'read' | 'missing' | 'unreadable' | 'error';
  /** True when the journal file was rewritten this call. */
  compacted: boolean;
  /** Why a read journal was not rewritten. */
  skipped?: 'under-cap' | 'unchanged' | 'malformed';
  beforeBytes: number;
  afterBytes: number | null;
  beforeLines: number;
  afterLines: number | null;
  /** Lines removed: superseded snapshots plus dead keys' latest snapshots. */
  dropped: number;
}

function compactionResult(
  state: QueueJournalCompaction['state'],
  beforeBytes = 0,
  beforeLines = 0,
  skipped?: QueueJournalCompaction['skipped'],
): QueueJournalCompaction {
  return { state, compacted: false, skipped, beforeBytes, afterBytes: null, beforeLines, afterLines: null, dropped: 0 };
}

/**
 * Rewrite the visit journal to its live evidence window once it exceeds
 * `maxBytes`. Every reader folds to the latest appended snapshot per
 * (station, pool, id), so compaction is observationally identical for them:
 * it keeps exactly the newest line of each surviving key, in original file
 * order. A key survives while its latest snapshot is open (no completedAt —
 * current WIP), completed within `recentMs`, or named in `keepKeys` (still
 * derivable from the bounded jobs-ledger tail or the live queue, so it can
 * never churn out and back in). Anything else — a completed visit whose job
 * has aged out of every evidence window — is dead weight and drops.
 *
 * Best-effort and total: a missing journal reports 'missing', an unreadable
 * or malformed one 'unreadable' (a corrupt line aborts the rewrite rather
 * than risking evidence loss), a failed write 'error' — the file is left
 * untouched in every non-compacted case. The rewrite goes through a unique
 * sibling + rename so readers never see a partial file, at the same 0600
 * mode the appends use.
 */
export async function compactQueueVisits(
  path = queueJournalPath(),
  opts: QueueJournalCompactionOptions = {},
): Promise<QueueJournalCompaction> {
  const maxBytes = opts.maxBytes ?? VISIT_JOURNAL_MAX_BYTES;
  const recentMs = opts.recentMs ?? VISIT_JOURNAL_RECENT_MS;
  const now = opts.now ?? Date.now();
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    return compactionResult((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  if (size <= maxBytes) return { ...compactionResult('read', size, 0, 'under-cap') };
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return compactionResult('unreadable', size);
  }
  const lines = content.split('\n').filter((line) => line.trim() !== '');
  const visits: QueueVisit[] = [];
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return compactionResult('unreadable', size, lines.length, 'malformed'); }
    if (!isQueueVisit(value)) return compactionResult('unreadable', size, lines.length, 'malformed');
    visits.push(value);
  }
  // Latest snapshot index per reader key; earlier snapshots of a surviving
  // key are superseded dead weight.
  const latest = new Map<string, number>();
  visits.forEach((visit, index) => latest.set(queueVisitKey(visit), index));
  const cutoff = now - recentMs;
  const keep = new Set<number>();
  let dropped = 0;
  for (const [key, index] of latest) {
    const visit = visits[index]!;
    const alive = visit.completedAt === undefined
      || visit.completedAt >= cutoff
      || opts.keepKeys?.has(key) === true;
    if (alive) keep.add(index);
    else dropped += 1;
  }
  dropped += visits.length - latest.size;
  const keptLines = [...keep].sort((a, b) => a - b).map((index) => lines[index]!);
  if (keptLines.length === lines.length) {
    return compactionResult('read', size, lines.length, 'unchanged');
  }
  const text = `${keptLines.join('\n')}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    return compactionResult('error', size, lines.length);
  }
  return {
    state: 'read', compacted: true, beforeBytes: size, afterBytes: Buffer.byteLength(text),
    beforeLines: lines.length, afterLines: keptLines.length, dropped,
  };
}
