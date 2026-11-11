/** The latest Gmail archive plan per inbox, saved so the desktop app can show it.
 * Counts and sender addresses only: no subjects, bodies or message ids. The plan proposes; nothing here moves mail. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

export const GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA = 'fleet.gmail-archive-plan-latest.v1';
const MAX_BYTES = 64 * 1024;
const MAX_INBOXES = 8;
const MAX_TOP_SENDERS = 3;
const MAX_LABEL = 64;
const MAX_SENDER = 120;

export interface GmailArchivePlanEntry {
  inbox: string;
  at: string;
  unread: number;
  target: number;
  archiveCount: number;
  topSenders: { sender: string; count: number }[];
}
export interface GmailArchivePlanLatest { schema: typeof GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA; plans: GmailArchivePlanEntry[] }
export type GmailArchivePlanInput = Omit<GmailArchivePlanEntry, 'at'> & { now?: () => Date };

export function gmailArchivePlanLatestPath(runsDir: string): string {
  return join(runsDir, 'comms', 'gmail-archive-plan-latest.json');
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function readEntry(raw: unknown): GmailArchivePlanEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.inbox !== 'string' || typeof e.at !== 'string' || !isCount(e.unread) || !isCount(e.target) || !isCount(e.archiveCount)) return null;
  if (!Array.isArray(e.topSenders) || e.topSenders.length > MAX_TOP_SENDERS) return null;
  const topSenders: GmailArchivePlanEntry['topSenders'] = [];
  for (const s of e.topSenders as Record<string, unknown>[]) {
    if (!s || typeof s.sender !== 'string' || !isCount(s.count)) return null;
    topSenders.push({ sender: s.sender.slice(0, MAX_SENDER), count: s.count });
  }
  return { inbox: e.inbox.slice(0, MAX_LABEL), at: e.at, unread: e.unread, target: e.target, archiveCount: e.archiveCount, topSenders };
}

/** The saved plans, or null when missing, unreadable, oversized or invalid. Never throws. */
export function readGmailArchivePlanLatest(runsDir: string): GmailArchivePlanLatest | null {
  try {
    const path = gmailArchivePlanLatestPath(runsDir);
    if (statSync(path).size > MAX_BYTES) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || raw.schema !== GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA || !Array.isArray(raw.plans)) return null;
    const plans = raw.plans.slice(0, MAX_INBOXES).map(readEntry);
    if (plans.some(p => p === null)) return null;
    return { schema: GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, plans: plans as GmailArchivePlanEntry[] };
  } catch {
    return null;
  }
}

/** Replaces the plan for this inbox and keeps the others under a cross-process lock. */
export function writeGmailArchivePlanLatest(runsDir: string, input: GmailArchivePlanInput): void {
  const path = gmailArchivePlanLatestPath(runsDir);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (statSync(dir).mode & 0o200) === 0) throw new Error('Gmail archive plan directory is not writable');
  const lock = acquireLocalStoreLock(`${path}.lock`, 0, { anchorPath: dir });
  if (!lock) throw new Error('Gmail archive plan is locked or unavailable');
  try {
    const { now, ...rest } = input;
    const entry: GmailArchivePlanEntry = {
      ...rest, inbox: rest.inbox.slice(0, MAX_LABEL), at: (now?.() ?? new Date()).toISOString(),
      topSenders: rest.topSenders.slice(0, MAX_TOP_SENDERS).map(s => ({ sender: s.sender.slice(0, MAX_SENDER), count: s.count })),
    };
    const others = (readGmailArchivePlanLatest(runsDir)?.plans ?? []).filter(p => p.inbox !== entry.inbox);
    const record: GmailArchivePlanLatest = { schema: GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, plans: [entry, ...others].slice(0, MAX_INBOXES) };
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
    try {
      if (!ownsLocalStoreLock(lock)) throw new Error('Gmail archive plan lock lost');
      renameSync(tmp, path);
    }
    catch (err) { try { unlinkSync(tmp); } catch { /* best effort */ } throw err; }
  } finally {
    releaseLocalStoreLock(lock);
  }
}
