/**
 * `phm fleet wt-audit` — per-worktree audit of ~/Projects/ashlrai/wt.
 *
 * For every direct subdirectory under the job-worktree root the audit reports
 * its lifecycle state (running, publishing, reaping, held, merged, published,
 * empty, finished, recorded, orphaned, ...) and its measured size, then marks
 * it `reapable` only when the evidence matches what the sanctioned reapers
 * already act on:
 *
 *   via 'reap-one'          ~/.ashlr-runs/bin/reap-one.sh <job> — dispatchd's
 *                           publisher/reaper. Eligible when <job>.base exists
 *                           and the job is provably not alive, not in flight,
 *                           not kept and either already published
 *                           (RESULT PR / RESULT EMPTY) or finished with the
 *                           publish still pending — reap-one.sh then runs
 *                           publish.sh and removes the worktree.
 *   via 'worktree-remove'   plain `git worktree remove` (the same removal
 *                           `ashlr fleet worktree-stale --apply` and
 *                           `wt-reap --apply` perform). Eligible when the
 *                           latest ledger outcome is MERGED, or the publish
 *                           result is already PR/EMPTY but the .base the
 *                           reaper needs is gone.
 *
 * Never eligible: running (a .dispatched marker, a pid file, a live process,
 * or a name in status.json), in-flight reaps/publishes, held worktrees
 * (queue keep.txt, status kept_worktrees, ~/.ashlr/kept-worktrees.json pins,
 * or a RESULT DENIED/ABORT/secret-shape/other kept for the supervisor),
 * ARCHIVED publishes (archive-reap.sh verifies the salvage sha first),
 * anything with no terminal evidence, and every worktree when a safety
 * source (jobs ledger, status.json, keep.txt, run markers, the runs-dir
 * listing, process table or pin file) cannot be read — unknown never
 * counts as safe.
 *
 * READ-ONLY: no deletes, no publishes, no queue writes. The audit lists
 * candidates; the sanctioned tools do the work.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSource, type Source } from './runs-parked-queue.js';
import {
  isKeptWorktree, measureWorktreeBytes, readKeptWorktrees,
  type KeptWorktrees, type WorktreeMeasurement,
} from '../worktree-retention.js';

export const WT_AUDIT_MAX_JOBS_BYTES = 8 * 1024 * 1024;
export const WT_AUDIT_MAX_FILE_BYTES = 256 * 1024;
/** Same launch grace dispatchd applies before a .base/.log pair counts as finished. */
export const WT_AUDIT_GRACE_MS = 180_000;
/** Shared measurement budget across every folder, like `phm disk`. */
const MEASURE_BUDGET_MS = 20_000;
const HOUR_MS = 3_600_000;

/** dispatchd's job-id shape (also the wt-reap folder-name rule). */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Lane guardians and hidden folders are never job worktrees. */
const EXCLUDED = (name: string): boolean => name.startsWith('.') || name.startsWith('guardian-');

export type WtAuditState =
  | 'invalid' | 'excluded'
  | 'running' | 'reaping' | 'publishing' | 'held' | 'archived'
  | 'merged' | 'open' | 'ended' | 'published' | 'empty' | 'finished'
  | 'recorded' | 'orphaned' | 'unknown';

export type WtReapVia = 'reap-one' | 'worktree-remove';
export type PublishClass = 'pr' | 'empty' | 'archived' | 'denied' | 'abort' | 'secret-shape' | 'other';

/** Filesystem surface the audit needs; every call fails soft so a missing
 * path is indistinguishable from an absent marker. */
export interface WtAuditFs {
  /** Names of direct subdirectories; null when the root cannot be read. */
  dirs(path: string): Promise<string[] | null>;
  /** Names of all direct entries; null when the root cannot be read. */
  entries(path: string): Promise<string[] | null>;
  /** Bounded file text; null when absent, unreadable or oversized. */
  text(path: string): Promise<string | null>;
  /** Modification time in ms; null when unreadable. */
  mtime(path: string): Promise<number | null>;
  /** Canonical path for alias-tolerant compares; null when unresolvable. */
  real(path: string): Promise<string | null>;
}

const defaultFs: WtAuditFs = {
  async dirs(path) {
    try {
      return (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
    } catch { return null; }
  },
  async entries(path) {
    try { return await readdir(path); } catch { return null; }
  },
  async text(path) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size > WT_AUDIT_MAX_FILE_BYTES) return null;
      const buffer = Buffer.alloc(info.size);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length).toString('utf8');
    } catch { return null; } finally { await file?.close().catch(() => undefined); }
  },
  async mtime(path) {
    try { return (await lstat(path)).mtimeMs; } catch { return null; }
  },
  async real(path) {
    try { return await realpath(path); } catch { return null; }
  },
};

const defaultPs = (): string | null => {
  try {
    return execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  } catch { return null; }
};

export interface WtAuditDeps {
  now?: number;
  wtRoot?: string;
  runsRoot?: string;
  fs?: WtAuditFs;
  /** Injected reader for metrics/jobs.jsonl; default reads a bounded tail. */
  readJobs?: (path: string) => Promise<{ state: Source; text: string }>;
  /** Injected process table (`ps -axo command=`); null marks it unavailable. */
  ps?: () => Promise<string | null> | string | null;
  /** Injected size scan; default is the bounded logical-byte measurer. */
  measure?: (dir: string) => WorktreeMeasurement | Promise<WorktreeMeasurement>;
  /** Injected kept-worktree policy read; default reads ~/.ashlr/kept-worktrees.json. */
  readPins?: () => KeptWorktrees | Promise<KeptWorktrees>;
  /** false skips the size walk entirely (the audit stays fast). */
  wantSize?: boolean;
}

/* ---------------------------------------------------------------------- */
/* Pure parsers — exported for unit tests, no I/O.                         */
/* ---------------------------------------------------------------------- */

/** Attempt-aware ledger record: `launch` opens a fresh attempt, so older
 * finish/outcome/publish evidence never protects a relaunched job. `rows`
 * counts every sighting and never resets — it is the orphan detector. */
export interface WtJobLedger {
  rows: number;
  launchMs: number | null;
  /** A finish row was seen this attempt, even when its ts did not parse. */
  finishSeen: boolean;
  finishMs: number | null;
  finishEmpty: boolean;
  outcomeState: string | null;
  outcomeMs: number | null;
  publishUrl: string | null;
  publishClass: string | null;
  lastMs: number | null;
}

export function parseAuditLedger(text: string): Map<string, WtJobLedger> {
  const jobs = new Map<string, WtJobLedger>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = row.job ?? row.job_id ?? row.id;
    if (typeof id !== 'string' || !JOB_ID.test(id)) continue;
    const event = row.event;
    if (typeof event !== 'string') continue;
    const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    const at = Number.isFinite(ts) ? ts : null;
    const entry = jobs.get(id) ?? {
      rows: 0, launchMs: null, finishSeen: false, finishMs: null, finishEmpty: false,
      outcomeState: null, outcomeMs: null, publishUrl: null, publishClass: null, lastMs: null,
    };
    entry.rows++;
    if (event === 'launch') {
      entry.launchMs = at;
      entry.finishSeen = false; entry.finishMs = null; entry.finishEmpty = false;
      entry.outcomeState = null; entry.outcomeMs = null;
      entry.publishUrl = null; entry.publishClass = null;
      entry.lastMs = at;
    } else {
      if (event === 'finish') {
        entry.finishSeen = true;
        entry.finishMs = at ?? entry.finishMs;
        entry.finishEmpty = row.empty === true;
      } else if (event === 'outcome') {
        entry.outcomeState = String(row.state ?? row.outcome ?? '').toLowerCase() || null;
        entry.outcomeMs = at ?? entry.outcomeMs;
      } else if (event === 'publish') {
        entry.publishUrl = typeof row.url === 'string' && /^https:\/\/github\.com\/[\w./-]{1,300}$/.test(row.url) ? row.url : null;
        entry.publishClass = typeof row.class === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(row.class) ? row.class : null;
      }
      if (at !== null && (entry.lastMs === null || at > entry.lastMs)) entry.lastMs = at;
    }
    jobs.set(id, entry);
  }
  return jobs;
}

/** PR urls whose outcome row says MERGED — matches dispatchd's `_merged_urls`
 * so a relaunched attempt that reused a merged PR still reads as landed. */
export function mergedUrlsFromLedger(text: string): Set<string> {
  const urls = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('MERGED')) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row?.event === 'outcome' && String(row.state ?? row.outcome ?? '').toUpperCase() === 'MERGED'
        && typeof row.url === 'string' && row.url) urls.add(row.url);
    } catch { /* skip torn rows */ }
  }
  return urls;
}

/** The last RESULT line in a .publish file, classified like reap-one.sh's
 * case statement. Returns null when no RESULT was ever written. */
export function classifyPublishText(text: string | null): { class: PublishClass; url: string | null } | null {
  if (text === null) return null;
  let last: string | null = null;
  for (const line of text.split(/\r?\n/)) if (line.startsWith('RESULT')) last = line.trim();
  if (last === null) return null;
  const pr = /^RESULT PR (\S+)/.exec(last);
  if (pr) return { class: 'pr', url: /^https:\/\/github\.com\/[\w./-]{1,300}$/.test(pr[1]!) ? pr[1]! : null };
  if (/^RESULT ARCHIVED\b/.test(last)) return { class: 'archived', url: null };
  if (/^RESULT EMPTY\b/.test(last)) return { class: 'empty', url: null };
  if (/^RESULT DENIED\b/.test(last)) return { class: 'denied', url: null };
  if (/secret-shape|PUBLISH-ABORT/i.test(last)) return { class: 'secret-shape', url: null };
  if (/^RESULT ABORT\b/.test(last)) return { class: 'abort', url: null };
  return { class: 'other', url: null };
}

/** dispatchd's ps scan: reap-one.sh/publish.sh children mark in-flight work;
 * launch.sh, a worktree path or a prompt path mark a live job. Pure. */
export function parsePsJobs(
  text: string, roots: { wtRoot: string; runsRoot: string },
): { alive: Set<string>; reaping: Set<string>; publishing: Set<string> } {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wt = new RegExp(`${escape(roots.wtRoot)}/([A-Za-z0-9._-]+)`);
  const prompt = new RegExp(`${escape(roots.runsRoot)}/([A-Za-z0-9._-]+?)\\.prompt\\b`);
  const launch = /launch\.sh ([A-Za-z0-9._-]+) /;
  const pub = /(?:^|\s)(?:\S*\/)?publish\.sh ([A-Za-z0-9._-]+)/;
  const reap = /(?:^|\s)(?:\S*\/)?reap-one\.sh ([A-Za-z0-9._-]+)/;
  const alive = new Set<string>(), reaping = new Set<string>(), publishing = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.includes('dispatchd.py')) continue;
    const reaper = reap.exec(line);
    const publisher = pub.exec(line);
    if (reaper || publisher) {
      if (reaper) reaping.add(reaper[1]!);
      if (publisher) publishing.add(publisher[1]!);
      continue;
    }
    for (const pattern of [wt, prompt, launch]) {
      const match = pattern.exec(line);
      if (match) { alive.add(match[1]!); break; }
    }
  }
  return { alive, reaping, publishing };
}

/** status.json's kept/reaping lists plus the raw text for reap-one.sh's
 * "named anywhere" quiet check. Invalid member names are dropped. */
export function parseStatusEvidence(text: string | null): { kept: Set<string>; reaping: Set<string>; raw: string | null } {
  if (text === null) return { kept: new Set(), reaping: new Set(), raw: null };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { kept: new Set(), reaping: new Set(), raw: text }; }
  const ids = (value: unknown): Set<string> =>
    new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && JOB_ID.test(v)) : []);
  const doc = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  return { kept: ids(doc.kept_worktrees), reaping: ids(doc.reaping), raw: text };
}

/** queue/keep.txt hold list: one job id per whitespace run. */
export function parseKeepList(text: string | null): Set<string> {
  const keep = new Set<string>();
  for (const token of (text ?? '').split(/\s+/)) if (JOB_ID.test(token)) keep.add(token);
  return keep;
}

/* ---------------------------------------------------------------------- */
/* Classification — pure over gathered evidence.                           */
/* ---------------------------------------------------------------------- */

export interface WtEvidence {
  name: string;
  /** Parsed `.base` (wt + pool) only when its recorded worktree is this dir. */
  pool: string | null;
  baseMatch: boolean;
  dispatched: boolean;
  rc: boolean;
  pid: boolean;
  reapingMarker: boolean;
  publish: { class: PublishClass; url: string | null } | null;
  ledger: WtJobLedger | undefined;
  ledgerMergedUrl: boolean;
  /** Newest timestamp found anywhere: ledger ts, .base/.log/.rc/dir mtime. */
  evidenceMs: number | null;
  statusNamed: boolean;
  statusKept: boolean;
  statusReaping: boolean;
  keepListed: boolean;
  pinned: boolean;
  psAlive: boolean;
  psReaping: boolean;
  psPublishing: boolean;
}

export interface WtAuditEntry {
  name: string;
  state: WtAuditState;
  pool: string | null;
  bytes: number | null;
  /** false means bytes is a partial floor from a bounded scan. */
  sizeComplete: boolean;
  /** Hours since the newest evidence timestamp; null when none exists. */
  ageHours: number | null;
  reapable: boolean;
  via: WtReapVia | null;
  /** Machine-readable reasons the worktree is protected. */
  blockers: string[];
  signals: {
    base: boolean; dispatched: boolean; rc: boolean; pid: boolean; reapingMarker: boolean;
    statusNamed: boolean; statusKept: boolean; statusReaping: boolean; keepListed: boolean;
    pinned: boolean; psAlive: boolean; psReaping: boolean; psPublishing: boolean;
    ledgerRows: number; outcome: string | null; publishClass: PublishClass | null;
  };
}

export interface WtAuditContext {
  now: number;
  /** Safety gates that failed globally; each name becomes a blocker.
   * `runs` = the runs-dir listing (can't see .base/.publish), `keep` =
   * keep.txt present but unreadable, `run` = queue/run listing (can't see
   * .dispatched/.rc/.pid/.reaping markers). */
  degraded: {
    jobs: boolean; status: boolean; ps: boolean; pins: boolean;
    runs: boolean; keep: boolean; run: boolean;
  };
}

const HELD_PUBLISH = new Set<PublishClass>(['denied', 'abort', 'secret-shape', 'other']);

/** One pass over the evidence: state roll-up, plan eligibility, blockers. */
export function classifyEntry(ev: WtEvidence, ctx: WtAuditContext): Omit<WtAuditEntry, 'bytes' | 'sizeComplete'> {
  const blockers: string[] = [];
  const ledger = ev.ledger;
  const outcome = ledger?.outcomeState ?? null;
  const merged = outcome === 'merged' || ev.ledgerMergedUrl;

  let state: WtAuditState;
  if (EXCLUDED(ev.name)) state = 'excluded';
  else if (!JOB_ID.test(ev.name)) state = 'invalid';
  else if (ev.dispatched || ev.pid || ev.psAlive) state = 'running';
  else if (ev.reapingMarker || ev.statusReaping || ev.psReaping) state = 'reaping';
  else if (ev.psPublishing) state = 'publishing';
  else if (ev.statusKept || ev.keepListed || ev.pinned
    || (ev.publish !== null && HELD_PUBLISH.has(ev.publish.class))) state = 'held';
  // reap-one.sh's quiet check: a job named anywhere in status.json is live.
  else if (ev.statusNamed) state = 'running';
  else if (ev.publish?.class === 'archived') state = 'archived';
  else if (merged) state = 'merged';
  // An outcome row is the job's own verdict; it outranks the publish result.
  else if (outcome === 'open') state = 'open';
  else if (outcome !== null) state = 'ended';
  else if (ev.publish?.class === 'pr') state = 'published';
  else if (ev.publish?.class === 'empty'
    || (ledger !== undefined && ledger.finishSeen && ledger.finishEmpty)) state = 'empty';
  else if (ev.rc || ledger?.finishSeen === true) state = 'finished';
  else if (ev.baseMatch || (ledger?.rows ?? 0) > 0 || ev.publish !== null) state = 'recorded';
  // No file evidence and no ledger sighting: only a fully-readable audit
  // can call it orphaned — any degraded source could hide the one signal
  // that proves the worktree alive, held or recorded.
  else state = Object.values(ctx.degraded).some(Boolean) ? 'unknown' : 'orphaned';

  // Blockers, in the same protective order as the state roll-up.
  if (state === 'invalid') blockers.push('invalid-name');
  if (state === 'excluded') blockers.push('excluded-standing');
  if (ev.dispatched) blockers.push('running:dispatched');
  if (ev.pid) blockers.push('running:pid');
  if (ev.psAlive) blockers.push('running:process');
  if (ev.statusNamed) blockers.push('running:status-named');
  if (ev.reapingMarker || ev.statusReaping || ev.psReaping) blockers.push('in-flight:reaping');
  if (ev.psPublishing) blockers.push('in-flight:publishing');
  if (ev.statusKept) blockers.push('held:status');
  if (ev.keepListed) blockers.push('held:keep-txt');
  if (ev.pinned) blockers.push('held:pinned');
  if (ev.publish !== null && HELD_PUBLISH.has(ev.publish.class)) blockers.push(`held:publish-${ev.publish.class}`);
  if (ev.publish?.class === 'archived') blockers.push('held:publish-archived');

  let via: WtReapVia | null = null;
  if (state === 'merged') via = 'worktree-remove';
  else if ((state === 'published' || state === 'empty') && !ev.baseMatch) via = 'worktree-remove';
  else if ((state === 'published' || state === 'empty' || state === 'finished') && ev.baseMatch) via = 'reap-one';
  else if (state === 'finished') blockers.push('unfinished-no-base');
  else if (state === 'orphaned') blockers.push('no-evidence');
  else if (state === 'unknown') blockers.push('no-evidence-unreadable-ledger');
  else if (state === 'recorded' || state === 'open' || state === 'ended') blockers.push(`not-terminal:${state}`);

  // Freshness grace: evidence written inside the window is still mid-handoff.
  if (via !== null && ev.evidenceMs !== null && ctx.now - ev.evidenceMs < WT_AUDIT_GRACE_MS) {
    blockers.push('fresh');
    via = null;
  }

  // Global fail-closed gates: an unread safety source proves nothing.
  if (via !== null) {
    if (ctx.degraded.jobs) { blockers.push('ledger-unreadable'); via = null; }
    if (ctx.degraded.status) { blockers.push('status-unreadable'); via = null; }
    if (ctx.degraded.ps) { blockers.push('ps-unavailable'); via = null; }
    if (ctx.degraded.pins) { blockers.push('pins-unreadable'); via = null; }
    if (ctx.degraded.runs) { blockers.push('runs-dir-unreadable'); via = null; }
    if (ctx.degraded.keep) { blockers.push('keep-list-unreadable'); via = null; }
    if (ctx.degraded.run) { blockers.push('run-markers-unreadable'); via = null; }
  }

  const ageHours = ev.evidenceMs === null ? null : Math.max(0, Math.round(((ctx.now - ev.evidenceMs) / HOUR_MS) * 10) / 10);
  return {
    name: ev.name,
    state,
    pool: ev.pool,
    ageHours,
    reapable: via !== null,
    via,
    blockers,
    signals: {
      base: ev.baseMatch, dispatched: ev.dispatched, rc: ev.rc, pid: ev.pid, reapingMarker: ev.reapingMarker,
      statusNamed: ev.statusNamed, statusKept: ev.statusKept, statusReaping: ev.statusReaping,
      keepListed: ev.keepListed, pinned: ev.pinned,
      psAlive: ev.psAlive, psReaping: ev.psReaping, psPublishing: ev.psPublishing,
      ledgerRows: ledger?.rows ?? 0,
      outcome,
      publishClass: ev.publish?.class ?? null,
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Orchestration.                                                          */
/* ---------------------------------------------------------------------- */

export interface WtAuditReport {
  schema: 'fleet.wt-audit.v1';
  generatedAt: string;
  readOnly: true;
  wtDir: string;
  runsDir: string;
  sources: {
    worktrees: Source;
    runs: Source;
    queue: Source;
    keep: Source;
    run: Source;
    jobs: Source;
    status: Source;
    ps: 'healthy' | 'unavailable';
    pins: 'valid' | 'invalid';
    sized: boolean;
  };
  worktrees: WtAuditEntry[];
  totals: {
    worktrees: number;
    bytes: number | null;
    complete: boolean;
    byState: Partial<Record<WtAuditState, number>>;
    reapable: number;
    reapableBytes: number;
  };
  reapPlan?: {
    count: number;
    bytes: number;
    complete: boolean;
    entries: Array<{ name: string; via: WtReapVia; state: WtAuditState; bytes: number | null; ageHours: number | null }>;
  };
}

/** `<job>.base` holds `BASE BR WT POOL`; the record only counts when its
 * worktree path is this directory, so a reused name never inherits evidence. */
async function readBase(
  fs: WtAuditFs, runsDir: string, wtRoot: string, name: string,
): Promise<{ pool: string | null; match: boolean; ms: number | null }> {
  const path = join(runsDir, `${name}.base`);
  const [text, ms] = await Promise.all([fs.text(path), fs.mtime(path)]);
  if (text === null) return { pool: null, match: false, ms };
  const fields = text.trim().split(/\s+/);
  const wt = fields.length >= 3 ? fields[2]! : '';
  const pool = fields.length >= 4 && /^[a-z][a-z0-9-]{0,31}$/i.test(fields[3]!) ? fields[3]! : null;
  const expected = join(wtRoot, name);
  if (resolve(wt) === resolve(expected)) return { pool, match: true, ms };
  const [realWt, realExpected] = await Promise.all([fs.real(wt), fs.real(expected)]);
  return { pool, match: realWt !== null && realWt === realExpected, ms };
}

export interface ReadWtAuditOptions extends WtAuditDeps { wantPlan?: boolean }

export async function readWtAudit(deps: ReadWtAuditOptions = {}): Promise<WtAuditReport> {
  const now = deps.now ?? Date.now();
  const home = homedir();
  const wtRoot = deps.wtRoot ?? process.env['ASHLR_WT_DIR'] ?? join(home, 'Projects', 'ashlrai', 'wt');
  const runsDir = deps.runsRoot ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
  const runDir = join(runsDir, 'queue', 'run');
  const fs = deps.fs ?? defaultFs;
  const wantSize = deps.wantSize !== false;

  const queueDir = join(runsDir, 'queue');
  const [dirs, runsEntries, queueEntries, runEntries, statusText, keepText, jobs, psText, pins] = await Promise.all([
    fs.dirs(wtRoot),
    fs.entries(runsDir),
    fs.entries(queueDir),
    fs.entries(runDir),
    fs.text(join(queueDir, 'status.json')),
    fs.text(join(queueDir, 'keep.txt')),
    (async () => {
      try {
        return await (deps.readJobs ?? ((path: string) => readSource(path, WT_AUDIT_MAX_JOBS_BYTES, true)))(
          join(runsDir, 'metrics', 'jobs.jsonl'));
      } catch { return { state: 'degraded' as Source, text: '' }; }
    })(),
    (async () => {
      try { return await (deps.ps ?? defaultPs)(); } catch { return null; }
    })(),
    (async () => {
      try { return await (deps.readPins ?? readKeptWorktrees)(); } catch { return { paths: [], valid: false } as KeptWorktrees; }
    })(),
  ]);

  const runsSet = new Set(runsEntries ?? []);
  const runSet = new Set(runEntries ?? []);
  const status = parseStatusEvidence(statusText);
  const keepListed = parseKeepList(keepText);
  const ledger = jobs.state === 'healthy' ? parseAuditLedger(jobs.text) : null;
  const mergedUrls = jobs.state === 'healthy' ? mergedUrlsFromLedger(jobs.text) : new Set<string>();
  const ps = psText === null ? null : parsePsJobs(psText, { wtRoot, runsRoot: runsDir });
  // 'absent' needs a positive listing that omits the name; an unreadable
  // parent listing leaves the file 'unknown' — which fails closed.
  const queuePresence = runsEntries === null ? 'unknown'
    : runsEntries.includes('queue') ? 'present' : 'absent';
  const presence = (name: string): 'present' | 'absent' | 'unknown' =>
    queuePresence === 'absent' ? 'absent'
      : queueEntries === null ? 'unknown'
        : queueEntries.includes(name) ? 'present' : 'absent';
  const statusPresence = presence('status.json');
  const keepPresence = presence('keep.txt');
  const runPresence = presence('run');
  const degraded = {
    jobs: jobs.state !== 'healthy',
    status: statusText === null && statusPresence !== 'absent',
    ps: ps === null,
    pins: pins.valid !== true,
    runs: runsEntries === null,
    keep: keepText === null && keepPresence !== 'absent',
    run: runEntries === null && runPresence !== 'absent',
  };
  const ctx: WtAuditContext = { now, degraded };

  const names = (dirs ?? []).sort();
  const measureDeadline = Date.now() + MEASURE_BUDGET_MS;
  const measure = deps.measure ?? (async (dir: string) =>
    measureWorktreeBytes(dir, { deadlineMs: measureDeadline }));

  const worktrees: WtAuditEntry[] = [];
  for (const name of names) {
    const dir = join(wtRoot, name);
    const hasBase = runsSet.has(`${name}.base`);
    const hasPublish = runsSet.has(`${name}.publish`);
    const [base, publishText, dirMs, logMs, rcMs] = await Promise.all([
      hasBase ? readBase(fs, runsDir, wtRoot, name) : Promise.resolve({ pool: null, match: false, ms: null }),
      hasPublish ? fs.text(join(runsDir, `${name}.publish`)) : Promise.resolve(null),
      fs.mtime(dir),
      runsSet.has(`${name}.log`) ? fs.mtime(join(runsDir, `${name}.log`)) : Promise.resolve(null),
      runSet.has(`${name}.rc`) ? fs.mtime(join(runDir, `${name}.rc`)) : Promise.resolve(null),
    ]);
    const publish = classifyPublishText(publishText);
    const record = ledger?.get(name);
    const evidenceMs = [record?.lastMs, base.ms, logMs, rcMs, dirMs]
      .reduce<number | null>((acc, ms) => (typeof ms === 'number' ? Math.max(acc ?? ms, ms) : acc), null);
    const ev: WtEvidence = {
      name,
      pool: base.pool,
      baseMatch: base.match,
      dispatched: runSet.has(`${name}.dispatched`),
      rc: runSet.has(`${name}.rc`),
      pid: runSet.has(`${name}.pid`) || runsSet.has(`${name}.pid`),
      reapingMarker: runSet.has(`${name}.reaping`),
      publish,
      ledger: record,
      ledgerMergedUrl: typeof record?.publishUrl === 'string' && mergedUrls.has(record.publishUrl),
      evidenceMs,
      statusNamed: status.raw !== null && status.raw.includes(`"${name}"`),
      statusKept: status.kept.has(name),
      statusReaping: status.reaping.has(name),
      keepListed: keepListed.has(name),
      pinned: isKeptWorktree(dir, pins),
      psAlive: ps?.alive.has(name) ?? false,
      psReaping: ps?.reaping.has(name) ?? false,
      psPublishing: ps?.publishing.has(name) ?? false,
    };
    const entry = classifyEntry(ev, ctx);
    let bytes: number | null = null;
    let sizeComplete = false;
    if (wantSize) {
      try {
        const measured = await measure(dir);
        bytes = measured.bytes;
        sizeComplete = measured.complete;
      } catch { sizeComplete = false; }
    }
    worktrees.push({ ...entry, bytes, sizeComplete });
  }

  // Biggest first — the folder that frees the most disk reads first.
  worktrees.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name));

  const byState: Partial<Record<WtAuditState, number>> = {};
  let complete = true;
  let bytes = 0;
  let reapable = 0;
  let reapableBytes = 0;
  for (const w of worktrees) {
    byState[w.state] = (byState[w.state] ?? 0) + 1;
    if (w.bytes !== null) bytes += w.bytes;
    complete &&= w.sizeComplete || !wantSize;
    if (w.reapable) {
      reapable++;
      reapableBytes += w.bytes ?? 0;
    }
  }

  const report: WtAuditReport = {
    schema: 'fleet.wt-audit.v1',
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    wtDir: wtRoot,
    runsDir,
    sources: {
      worktrees: dirs === null ? 'degraded' : 'healthy',
      runs: runsEntries === null ? 'degraded' : 'healthy',
      queue: queuePresence === 'absent' ? 'missing' : queueEntries === null ? 'degraded' : 'healthy',
      keep: keepText === null ? (keepPresence === 'absent' ? 'missing' : 'degraded') : 'healthy',
      run: runEntries === null ? (runPresence === 'absent' ? 'missing' : 'degraded') : 'healthy',
      jobs: jobs.state,
      status: statusText === null ? (statusPresence === 'absent' ? 'missing' : 'degraded') : 'healthy',
      ps: ps === null ? 'unavailable' : 'healthy',
      pins: pins.valid ? 'valid' : 'invalid',
      sized: wantSize,
    },
    worktrees,
    totals: {
      worktrees: worktrees.length,
      bytes: wantSize ? bytes : null,
      complete: wantSize ? complete && worktrees.every(w => w.bytes !== null) : true,
      byState,
      reapable,
      reapableBytes,
    },
  };

  if (deps.wantPlan) {
    const entries = worktrees.filter(w => w.reapable).map(w =>
      ({ name: w.name, via: w.via!, state: w.state, bytes: w.bytes, ageHours: w.ageHours }));
    report.reapPlan = {
      count: entries.length,
      bytes: entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0),
      complete: entries.every(e => e.bytes !== null),
      entries,
    };
  }
  return report;
}

/* ---------------------------------------------------------------------- */
/* Human formatting — pure.                                                */
/* ---------------------------------------------------------------------- */

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function formatGb(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  const gb = round1(bytes / 1e9);
  return `${gb === 0 && bytes > 0 ? '<0.1' : gb} GB`;
}

export function formatWtAudit(report: WtAuditReport): string[] {
  const lines = ['wt audit — reads only, deletes nothing'];
  const counts = Object.entries(report.totals.byState).sort((a, b) => b[1] - a[1]);
  lines.push(`worktrees under ${report.wtDir}: ${report.totals.worktrees === 0 ? 'none'
    : `${report.totals.worktrees} (${report.totals.bytes === null ? 'size unknown' : formatGb(report.totals.bytes)})`}`);
  if (counts.length) lines.push(`states: ${counts.map(([state, n]) => `${n} ${state}`).join(', ')}`);
  const { reapable, reapableBytes } = report.totals;
  if (reapable === 0) lines.push('reapable now: none (see per-worktree blockers in --json)');
  else lines.push(`reapable now: ${reapable} (${formatGb(reapableBytes)}) — add --reap-plan for the list`);
  const degraded = Object.entries(report.sources)
    .filter(([key, v]) => key !== 'sized' && (v === 'degraded' || v === 'unavailable' || v === 'invalid'));
  if (degraded.length) {
    lines.push(`degraded sources: ${degraded.map(([k, v]) => `${k}=${v}`).join(', ')} — unproven worktrees are never listed as reapable`);
  }
  return lines;
}

export function formatWtReapPlan(report: WtAuditReport): string[] {
  const plan = report.reapPlan;
  const lines = ['reap plan — candidates for sanctioned reaping only; deletes nothing'];
  if (!plan || plan.count === 0) {
    lines.push('no worktree is provably safe to reap right now');
    const degraded = Object.entries(report.sources)
      .filter(([key, v]) => key !== 'sized' && (v === 'degraded' || v === 'unavailable' || v === 'invalid'));
    if (degraded.length) lines.push(`degraded sources may hide candidates: ${degraded.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    return lines;
  }
  for (const entry of plan.entries) {
    const size = entry.bytes === null ? 'size unknown' : formatGb(entry.bytes);
    const age = entry.ageHours === null ? 'age unknown' : `${entry.ageHours}h`;
    lines.push(`${entry.name}: ${entry.via}, ${size}, ${entry.state}, ${age}`);
  }
  lines.push(`total: ${plan.count} worktree(s), ${formatGb(plan.bytes)}${plan.complete ? '' : ' (partial sizes)'}`);
  lines.push('reap-one = ~/.ashlr-runs/bin/reap-one.sh <job>; worktree-remove = git worktree remove (fleet worktree-stale --apply / wt-reap --apply semantics).');
  return lines;
}
