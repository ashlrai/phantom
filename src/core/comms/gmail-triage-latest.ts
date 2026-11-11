/** The last Gmail triage result per inbox, saved so the desktop app and agents can read it.
 * Counts and a short directory label only: no subjects, senders, bodies or message ids.
 *
 * Storage is one JSON file at comms/gmail-triage-latest.json holding a v2 envelope:
 * `{ schema: 'fleet.gmail-triage-latest.v2', latest, inboxes }`. `latest` keeps the
 * legacy last-write-wins record; `inboxes` keeps one record per directory label so
 * both inbox reports survive. Labels are basenames only: two account directories
 * that share a basename are the same label here and share one entry (last write
 * wins); this is a label-identity limitation, not proof of distinct accounts.
 * Bare v1 files (a single record) still load and migrate on the next write. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

export const GMAIL_TRIAGE_LATEST_SCHEMA = 'fleet.gmail-triage-latest.v1';
export const GMAIL_TRIAGE_STORE_SCHEMA = 'fleet.gmail-triage-latest.v2';
const MAX_BYTES = 64 * 1024;
const MAX_INBOXES = 8;
const MAX_LABEL = 64;
const COUNT_KEYS = ['scanned', 'updates', 'drafted', 'review', 'failed', 'unreadInSample', 'target', 'archiveCandidateCount'] as const;

export interface GmailTriageLatest {
  schema: typeof GMAIL_TRIAGE_LATEST_SCHEMA;
  at: string;
  dir: string;
  scanned: number;
  updates: number;
  drafted: number;
  review: number;
  failed: number;
  unreadInSample: number;
  target: number;
  archiveCandidateCount: number;
}

export type GmailTriageLatestInput = Omit<GmailTriageLatest, 'schema' | 'at' | 'dir'> & { dir: string; now?: () => Date };

/** The bounded per-inbox projection: `latest` is the legacy last-write record and
 * `inboxes` holds one count-only record per directory label, newest first. */
export interface GmailTriageInboxReports {
  schema: typeof GMAIL_TRIAGE_STORE_SCHEMA;
  latest: GmailTriageLatest | null;
  inboxes: GmailTriageLatest[];
}

interface GmailTriageStore {
  latest: GmailTriageLatest | null;
  /** Keyed by the record's directory label; values are the same records. */
  inboxes: Record<string, GmailTriageLatest>;
}

export function gmailTriageLatestPath(runsDir: string): string {
  return join(runsDir, 'comms', 'gmail-triage-latest.json');
}

function readRecord(raw: unknown): GmailTriageLatest | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.schema !== GMAIL_TRIAGE_LATEST_SCHEMA) return null;
  if (typeof record.at !== 'string' || typeof record.dir !== 'string') return null;
  for (const key of COUNT_KEYS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  }
  const picked = Object.fromEntries(COUNT_KEYS.map(key => [key, record[key]]));
  return { schema: GMAIL_TRIAGE_LATEST_SCHEMA, at: record.at, dir: record.dir.slice(0, MAX_LABEL), ...picked } as GmailTriageLatest;
}

/** Parses the store file: a v2 envelope, or a bare v1 record treated as both the
 * latest result and its single inbox entry. Null on missing, unreadable, oversized
 * or invalid content. Never throws. */
function readStore(runsDir: string): GmailTriageStore | null {
  try {
    const path = gmailTriageLatestPath(runsDir);
    if (statSync(path).size > MAX_BYTES) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return null;
    if (raw.schema === GMAIL_TRIAGE_LATEST_SCHEMA) {
      const latest = readRecord(raw);
      return latest === null ? null : { latest, inboxes: { [latest.dir]: latest } };
    }
    if (raw.schema !== GMAIL_TRIAGE_STORE_SCHEMA) return null;
    const latestRaw = raw.latest;
    const latest = latestRaw === null || latestRaw === undefined ? null : readRecord(latestRaw);
    if (latestRaw !== null && latestRaw !== undefined && latest === null) return null;
    if (raw.inboxes !== undefined && (raw.inboxes === null || typeof raw.inboxes !== 'object' || Array.isArray(raw.inboxes))) return null;
    const inboxes: Record<string, GmailTriageLatest> = {};
    for (const value of Object.values((raw.inboxes ?? {}) as Record<string, unknown>)) {
      const entry = readRecord(value);
      if (entry === null || entry.dir in inboxes || Object.keys(inboxes).length >= MAX_INBOXES) continue;
      inboxes[entry.dir] = entry;
    }
    return { latest, inboxes };
  } catch {
    return null;
  }
}

/** The saved report, or null when missing, unreadable, oversized or invalid. Never throws. */
export function readGmailTriageLatest(runsDir: string): GmailTriageLatest | null {
  return readStore(runsDir)?.latest ?? null;
}

/** The saved per-inbox projection, or null when missing, unreadable, oversized or
 * invalid. A legacy v1 file projects as its single inbox entry. Never throws. */
export function readGmailTriageInboxReports(runsDir: string): GmailTriageInboxReports | null {
  const store = readStore(runsDir);
  if (!store) return null;
  return { schema: GMAIL_TRIAGE_STORE_SCHEMA, latest: store.latest, inboxes: Object.values(store.inboxes).slice(0, MAX_INBOXES) };
}

/** Saves the report under a cross-process lock: replaces this label's inbox entry,
 * keeps the others (bounded), refreshes `latest`, and migrates a bare v1 file.
 * Lock or storage failures throw so callers can report the save as failed. */
export function writeGmailTriageLatest(runsDir: string, input: GmailTriageLatestInput): void {
  const { now, dir, ...counts } = input;
  const record: GmailTriageLatest = {
    schema: GMAIL_TRIAGE_LATEST_SCHEMA,
    at: (now?.() ?? new Date()).toISOString(),
    dir: basename(dir).slice(0, MAX_LABEL),
    ...counts,
  };
  const path = gmailTriageLatestPath(runsDir);
  const storeDir = dirname(path);
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (statSync(storeDir).mode & 0o200) === 0) throw new Error('Gmail triage directory is not writable');
  const lock = acquireLocalStoreLock(`${path}.lock`, 0, { anchorPath: storeDir });
  if (!lock) throw new Error('Gmail triage latest is locked or unavailable');
  try {
    const prior = readStore(runsDir);
    const inboxes: Record<string, GmailTriageLatest> = { [record.dir]: record };
    for (const [label, entry] of Object.entries(prior?.inboxes ?? {})) {
      if (label === record.dir || Object.keys(inboxes).length >= MAX_INBOXES) continue;
      inboxes[label] = entry;
    }
    const store = { schema: GMAIL_TRIAGE_STORE_SCHEMA, latest: record, inboxes };
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(store)}\n`);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
    closeSync(fd);
    try {
      if (!ownsLocalStoreLock(lock)) throw new Error('Gmail triage latest lock lost');
      renameSync(tmp, path);
    }
    catch (err) { try { unlinkSync(tmp); } catch { /* best effort */ } throw err; }
  } finally {
    releaseLocalStoreLock(lock);
  }
}
