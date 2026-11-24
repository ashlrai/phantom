/**
 * job-state.ts — the one place that decides whether a fleet job is running.
 *
 * A publish record (`J.publish`) holding `RESULT PR <url>` or `RESULT EMPTY`
 * means the job is done, whatever its worktree or log look like. Devin cloud
 * jobs have a `J.base` record and a worktree but never a local log, so the old
 * "no log means still launching" rule counted them as running forever.
 *
 * Without a valid RESULT line the earlier rules stay: a base record plus an
 * existing worktree is running while its log is missing or fresh.
 * A publish record that names a RESULT but cannot be parsed is `unknown`,
 * never `running`.
 *
 * `jobStateOf` is pure. `readJobState` is the bounded read-only file reader
 * behind `phm jobs state <id>`.
 */

import { lstat, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const JOB_STATE_VERSION = 1;
/** A log touched this recently means the worker is alive (dispatchd's recency window). */
export const JOB_LOG_FRESH_MS = 180_000;

export type JobStateName = 'running' | 'done' | 'idle' | 'unknown';
export type JobResult = { kind: 'pr'; url: string } | { kind: 'empty' } | null;

export interface JobStateEvidence {
  /** `J.publish` text, or null when the file is missing. */
  publish: string | null;
  hasBase: boolean;
  /** The worktree named in `J.base` exists. */
  hasWorktree: boolean;
  /** `J.log` mtime in ms, or null when no local log exists. */
  logMtimeMs: number | null;
  baseMtimeMs: number | null;
  nowMs: number;
}

export interface JobState {
  version: typeof JOB_STATE_VERSION;
  state: JobStateName;
  result: JobResult;
  /** Plain-words reasons, in the order they were checked. */
  evidence: string[];
}

const PR_URL = /^https:\/\/[^\s/]+\/\S+$/;

/** The last RESULT line decides, like dispatchd. `malformed` means a RESULT line exists but is not PR <url> or EMPTY. */
export function parsePublishResult(text: string): { result: JobResult; malformed: boolean } {
  const lines = text.split('\n').map(l => l.trim()).filter(l => /^RESULT\b/.test(l));
  const last = lines[lines.length - 1];
  if (last === undefined) return { result: null, malformed: false };
  const pr = /^RESULT\s+PR\s+(\S+)(?:\s.*)?$/.exec(last);
  if (pr && PR_URL.test(pr[1]!)) return { result: { kind: 'pr', url: pr[1]! }, malformed: false };
  if (/^RESULT\s+EMPTY(\s|$)/.test(last)) return { result: { kind: 'empty' }, malformed: false };
  return { result: null, malformed: true };
}

export function jobStateOf(e: JobStateEvidence): JobState {
  const evidence: string[] = [];
  if (e.publish !== null) {
    const { result, malformed } = parsePublishResult(e.publish);
    if (result) {
      evidence.push(result.kind === 'pr' ? `publish record says RESULT PR ${result.url}` : 'publish record says RESULT EMPTY');
      if (e.hasWorktree) evidence.push('worktree still exists (ignored)');
      if (e.logMtimeMs === null) evidence.push('no local log (ignored)');
      return { version: JOB_STATE_VERSION, state: 'done', result, evidence };
    }
    if (malformed) {
      evidence.push('publish record has a RESULT line that is not "RESULT PR <url>" or "RESULT EMPTY"');
      return { version: JOB_STATE_VERSION, state: 'unknown', result: null, evidence };
    }
    evidence.push('publish record has no RESULT line yet');
  } else {
    evidence.push('no publish record');
  }
  if (!e.hasBase) {
    evidence.push('no base record');
    return { version: JOB_STATE_VERSION, state: 'idle', result: null, evidence };
  }
  if (!e.hasWorktree) {
    evidence.push('base record found, worktree is gone');
    return { version: JOB_STATE_VERSION, state: 'idle', result: null, evidence };
  }
  if (e.logMtimeMs === null) {
    evidence.push('base record and worktree exist, no local log yet (in flight)');
    return { version: JOB_STATE_VERSION, state: 'running', result: null, evidence };
  }
  const age = e.nowMs - Math.max(e.logMtimeMs, e.baseMtimeMs ?? 0);
  if (age < JOB_LOG_FRESH_MS) {
    evidence.push(`log touched ${Math.max(0, Math.round(age / 1000))}s ago`);
    return { version: JOB_STATE_VERSION, state: 'running', result: null, evidence };
  }
  evidence.push(`log last touched ${Math.round(age / 1000)}s ago (over ${JOB_LOG_FRESH_MS / 1000}s)`);
  return { version: JOB_STATE_VERSION, state: 'idle', result: null, evidence };
}

export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const JOB_ID = JOB_ID_PATTERN;
const READ_BYTES = 64 * 1024;

async function mtime(path: string): Promise<number | null> {
  try { const s = await lstat(path); return s.isFile() ? s.mtimeMs : null; } catch { return null; }
}

async function readHead(path: string, tail: boolean): Promise<string | null> {
  try {
    const s = await lstat(path);
    if (!s.isFile()) return null;
    const length = Math.min(s.size, READ_BYTES);
    const fh = await open(path);
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, tail ? s.size - length : 0);
      return buf.toString('utf8', 0, bytesRead);
    } finally { await fh.close(); }
  } catch { return null; }
}

export interface ReadJobStateOptions { runsDir?: string; now?: () => number }

export async function readJobState(job: string, options: ReadJobStateOptions = {}): Promise<JobState & { job: string }> {
  if (!JOB_ID.test(job)) throw new Error('invalid fleet job id');
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new Error('runsDir must be an absolute path');
  const file = (s: string) => join(runsDir, `${job}.${s}`);
  const baseText = await readHead(file('base'), false);
  const fields = baseText?.trim().split(/\s+/) ?? [];
  const worktree = fields.length >= 3 ? fields[2]! : null;
  let hasWorktree = false;
  if (worktree !== null && isAbsolute(worktree)) {
    try { hasWorktree = (await stat(worktree)).isDirectory(); } catch { hasWorktree = false; }
  }
  const state = jobStateOf({
    publish: await readHead(file('publish'), true),
    hasBase: baseText !== null,
    hasWorktree,
    logMtimeMs: await mtime(file('log')),
    baseMtimeMs: await mtime(file('base')),
    nowMs: options.now?.() ?? Date.now(),
  });
  return { job, ...state };
}
