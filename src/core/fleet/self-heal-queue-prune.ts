import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkItem } from '../types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

export interface PruneQueuedSelfHealItemsResult {
  scanned: number;
  removed: number;
  failed: boolean;
}

function writeFileAtomic(filePath: string, text: string): void {
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

function readQueue(path: string): WorkItem[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('self-heal queue is malformed');
  return parsed as WorkItem[];
}

/** Remove selected generated rows from both mutable queue projections. */
export function pruneQueuedSelfHealItems(
  shouldRemove: (item: WorkItem) => boolean,
): PruneQueuedSelfHealItemsResult {
  const root = join(homedir(), '.ashlr');
  const lock = acquireLocalStoreLock(join(root, '.self-heal-queue.lock'));
  if (!lock) return { scanned: 0, removed: 0, failed: true };
  let scanned = 0;
  let removed = 0;
  let failed = false;
  try {
    const path = join(root, 'self-heal-queue.json');
    const existing = readQueue(path);
    scanned += existing.length;
    const filtered = existing.filter((item) => !shouldRemove(item));
    removed += existing.length - filtered.length;
    if (filtered.length !== existing.length) writeJsonAtomic(path, filtered);
  } catch {
    failed = true;
  }
  try {
    const path = join(root, 'backlog.json');
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) {
        scanned += parsed.length;
        const filtered = parsed.filter((item) => !shouldRemove(item as WorkItem));
        removed += parsed.length - filtered.length;
        if (filtered.length !== parsed.length) writeJsonAtomic(path, filtered);
      } else if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { items?: unknown }).items)
      ) {
        const envelope = parsed as { items: unknown[] };
        scanned += envelope.items.length;
        const filtered = envelope.items.filter((item) => !shouldRemove(item as WorkItem));
        removed += envelope.items.length - filtered.length;
        if (filtered.length !== envelope.items.length) writeJsonAtomic(path, { ...parsed, items: filtered });
      }
    }
  } catch {
    failed = true;
  }
  releaseLocalStoreLock(lock);
  return { scanned, removed, failed };
}

// ---------------------------------------------------------------------------
// Router queue lines: mark entries whose PR reached a terminal state as DONE
// ---------------------------------------------------------------------------

export interface MarkMergedQueueLinesResult {
  /** Queue bullet lines (`- <STATUS> <id> ...`) examined. */
  scanned: number;
  /** Lines rewritten to `- DONE`. */
  marked: number;
  /** True when the lock, queue read, cache read or write failed. */
  failed: boolean;
}

export interface MarkMergedQueueLinesOptions {
  /** Markdown router queue file (`- <STATUS> <id> (<meta>): <detail>` lines). */
  queuePath: string;
  /**
   * Cached `gh` JSON: a `gh pr list --json number,url,state` array, a `{ prs: [...] }`
   * envelope, or one `gh pr view --json url,state` object. The snapshot is taken
   * elsewhere; this function never shells out to `gh`.
   */
  ghCachePath: string;
}

const QUEUE_LINE_RE = /^(-\s+)([A-Z][A-Z0-9-]*)(?=\s+\S)/;
const PR_URL_SHAPE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9_.-]{1,100}\/pull\/[1-9][0-9]{0,9}$/i;
const PR_FIELD_RE = /(?:^|[^A-Za-z0-9_])PR=(https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9_.-]{1,100}\/pull\/[1-9][0-9]{0,9})/gi;
const TERMINAL_LINE_STATUSES = new Set(['DONE', 'CANCELLED']);
const TERMINAL_PR_STATES = new Set(['merged', 'closed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict PR URL → canonical lowercase lookup key, or null for anything else. */
function canonicalPrUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return PR_URL_SHAPE.test(url) ? url.toLowerCase() : null;
}

/**
 * Build URL → state from a cached `gh` JSON value. Returns null when the input
 * is structurally unusable: rows without a well-formed `url`/`state` pair are
 * dropped, but a non-empty payload with zero usable rows is a malformed cache,
 * not an empty one — the caller must not mark on it. Conflicting states for
 * the same URL collapse to 'mixed', which is not terminal, so contested PRs
 * are never marked.
 */
function ghPrStatesFromCache(parsed: unknown): Map<string, string> | null {
  let rows: unknown[];
  if (Array.isArray(parsed)) rows = parsed;
  else if (isRecord(parsed) && Array.isArray(parsed['prs'])) rows = parsed['prs'];
  else if (isRecord(parsed)) rows = [parsed];
  else return null;
  const states = new Map<string, string>();
  let usable = 0;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const key = canonicalPrUrl(row['url']);
    const state = typeof row['state'] === 'string' ? row['state'].trim().toLowerCase() : '';
    if (key === null || state === '') continue;
    usable += 1;
    const prior = states.get(key);
    states.set(key, prior === undefined || prior === state ? state : 'mixed');
  }
  return rows.length === 0 || usable > 0 ? states : null;
}

/**
 * Rewrite `- <STATUS>` queue lines to `- DONE` when every `PR=` field on the
 * line resolves to a PR whose cached state is merged or closed. Only the
 * status token changes — comments, blank lines, ordering, ids, metadata and
 * unknown fields survive byte-identically, and lines already in a terminal
 * status (DONE/CANCELLED) are never rewritten. A missing queue is not an
 * error; a missing or malformed cache, lock failure, or I/O error is.
 */
export function markMergedQueueLinesDone(
  options: MarkMergedQueueLinesOptions,
): MarkMergedQueueLinesResult {
  const { queuePath, ghCachePath } = options;
  if (!existsSync(queuePath)) return { scanned: 0, marked: 0, failed: false };
  let states: Map<string, string>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(ghCachePath, 'utf8'));
    const map = ghPrStatesFromCache(parsed);
    if (!map) return { scanned: 0, marked: 0, failed: true };
    states = map;
  } catch {
    return { scanned: 0, marked: 0, failed: true };
  }
  const lock = acquireLocalStoreLock(`${queuePath}.lock`);
  if (!lock) return { scanned: 0, marked: 0, failed: true };
  try {
    const text = readFileSync(queuePath, 'utf8');
    let scanned = 0;
    let marked = 0;
    const rewritten = text.split('\n').map((line) => {
      const match = QUEUE_LINE_RE.exec(line);
      if (!match) return line;
      scanned += 1;
      if (TERMINAL_LINE_STATUSES.has(match[2]!)) return line;
      const prs = new Set<string>();
      for (const field of line.matchAll(PR_FIELD_RE)) prs.add(field[1]!.toLowerCase());
      if (prs.size === 0) return line;
      for (const url of prs) {
        if (!TERMINAL_PR_STATES.has(states.get(url) ?? '')) return line;
      }
      marked += 1;
      return `${match[1]!}DONE${line.slice(match[1]!.length + match[2]!.length)}`;
    });
    if (marked > 0) writeFileAtomic(queuePath, rewritten.join('\n'));
    return { scanned, marked, failed: false };
  } catch {
    return { scanned: 0, marked: 0, failed: true };
  } finally {
    releaseLocalStoreLock(lock);
  }
}
