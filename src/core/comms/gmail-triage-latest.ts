/** The last Gmail triage result, saved so the desktop app and agents can read it.
 * Counts and a short directory label only: no subjects, senders, bodies or message ids. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const GMAIL_TRIAGE_LATEST_SCHEMA = 'fleet.gmail-triage-latest.v1';
const MAX_BYTES = 64 * 1024;
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

export function gmailTriageLatestPath(runsDir: string): string {
  return join(runsDir, 'comms', 'gmail-triage-latest.json');
}

export function writeGmailTriageLatest(runsDir: string, input: GmailTriageLatestInput): void {
  const { now, dir, ...counts } = input;
  const record: GmailTriageLatest = {
    schema: GMAIL_TRIAGE_LATEST_SCHEMA,
    at: (now?.() ?? new Date()).toISOString(),
    dir: basename(dir).slice(0, MAX_LABEL),
    ...counts,
  };
  const path = gmailTriageLatestPath(runsDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  closeSync(fd);
  try { renameSync(tmp, path); }
  catch (err) { try { unlinkSync(tmp); } catch { /* best effort */ } throw err; }
}

/** The saved report, or null when missing, unreadable, oversized or invalid. Never throws. */
export function readGmailTriageLatest(runsDir: string): GmailTriageLatest | null {
  try {
    const path = gmailTriageLatestPath(runsDir);
    if (statSync(path).size > MAX_BYTES) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || raw.schema !== GMAIL_TRIAGE_LATEST_SCHEMA) return null;
    if (typeof raw.at !== 'string' || typeof raw.dir !== 'string') return null;
    for (const key of COUNT_KEYS) {
      const value = raw[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    }
    const picked = Object.fromEntries(COUNT_KEYS.map(key => [key, raw[key]]));
    return { schema: GMAIL_TRIAGE_LATEST_SCHEMA, at: raw.at, dir: raw.dir.slice(0, MAX_LABEL), ...picked } as GmailTriageLatest;
  } catch {
    return null;
  }
}
