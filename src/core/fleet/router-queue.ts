/**
 * src/core/fleet/router-queue.ts: tolerant reader for the Ashlr router
 * queue snapshot at `~/.ashlr-runs/queue/{jobs.jsonl,status.json}`.
 *
 * Interchange schema v1 (docs/router/fleet-view.md):
 *   jobs.jsonl   one JSON object per job:
 *                {schemaVersion:1, id, lane, tier, outcome?, tokens?,
 *                 startedAt?, mergedAt?, pr?, reverted?, impact?, repo?, title?}
 *   status.json  {schemaVersion:1, jobsSha256:<sha256 of the exact jobs.jsonl
 *                bytes>, jobs:[{id, ...measurement overrides}]}
 *
 * This is a VIEW read, not evidence authority: every file degrades
 * independently. Missing files are `missing`; unreadable, oversized,
 * non-regular or symlinked files are `unsafe`; malformed JSON is `invalid`.
 * Invalid rows are dropped and counted rather than aborting the read, and a
 * status/jobs hash mismatch skips only the overlay (the jobs rows still
 * serve). The reader never writes, never echoes raw records into its detail
 * strings, and never throws.
 */

import { createHash } from 'node:crypto';
import { lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/** Per-file caps: a queue log stays small; refuse to page in a dump. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_JOBS = 100_000;
const MAX_TEXT_FIELD = 256;

export const ROUTER_QUEUE_OUTCOMES = ['queued', 'running', 'merged', 'empty', 'failed', 'cancelled'] as const;
export type RouterQueueOutcome = (typeof ROUTER_QUEUE_OUTCOMES)[number];

export interface RouterQueueJob {
  id: string;
  lane: string;
  tier: string;
  outcome?: RouterQueueOutcome;
  /** Cumulative tokens across attempts; absent means unmeasured. */
  tokens?: number;
  /** Canonical-UTC instants, as epoch ms. */
  startedAt?: number;
  mergedAt?: number;
  /** `owner/repository#number`, lowercased. */
  pr?: string;
  reverted?: boolean;
  impact?: number;
  /** Optional `owner/repository` job target. */
  repo?: string;
  /** Optional short job label (bounded, control characters stripped). */
  title?: string;
}

export type RouterQueueFileState = 'ok' | 'missing' | 'unsafe' | 'invalid';

export interface RouterQueueFileRead {
  state: RouterQueueFileState;
  bytes: number | null;
  sha256: string | null;
  mtimeMs: number | null;
  rowsRead: number;
  rowsDropped: number;
  detail: string;
}

export interface RouterQueueStatusRead extends RouterQueueFileRead {
  /** Overlay rows applied on top of the jobs snapshot. */
  applied: number;
  /** Whether status.jobsSha256 bound the exact jobs bytes read. */
  hashMatched: boolean | null;
}

export interface RouterQueueSnapshot {
  /** Merged (jobs + applied overlay) job rows, in file order. */
  jobs: RouterQueueJob[];
  jobsFile: RouterQueueFileRead;
  statusFile: RouterQueueStatusRead;
  /** 'ok' when jobs read clean; 'partial' when jobs served but status did not apply; 'missing'/'invalid'/'unsafe' when no jobs could be served. */
  state: 'ok' | 'partial' | RouterQueueFileState;
}

// ---------------------------------------------------------------------------
// Field validation: mirrors the interchange contract; silently drops rows.
// ---------------------------------------------------------------------------

const IDENT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PR_IDENT = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+#[1-9]\d*$/;
const REPO_IDENT = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const CANONICAL_INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function isRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ident(value: unknown): string | null {
  return typeof value === 'string' && IDENT.test(value) ? value : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_FIELD) return null;
  // Strip control characters so a hostile row cannot inject escapes into the TUI.
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out.trim().length > 0 ? out : null;
}

function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !CANONICAL_INSTANT.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

function measurement(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

const COMPLETE: readonly RouterQueueOutcome[] = ['merged', 'empty', 'failed', 'cancelled'];

function isComplete(job: RouterQueueJob): boolean {
  return job.outcome !== undefined && COMPLETE.includes(job.outcome);
}

/** Fields a status overlay may replace or supply; identity fields never move. */
function overlayFields(row: Record<string, unknown>, into: Partial<RouterQueueJob>): boolean {
  if (row.outcome !== undefined) {
    if (!ROUTER_QUEUE_OUTCOMES.includes(row.outcome as RouterQueueOutcome)) return false;
    into.outcome = row.outcome as RouterQueueOutcome;
  }
  if (row.tokens !== undefined) {
    const tokens = measurement(row.tokens);
    if (tokens === null || !Number.isSafeInteger(tokens)) return false;
    into.tokens = tokens;
  }
  if (row.startedAt !== undefined) {
    const at = instant(row.startedAt);
    if (at === null) return false;
    into.startedAt = at;
  }
  if (row.mergedAt !== undefined) {
    const at = instant(row.mergedAt);
    if (at === null) return false;
    into.mergedAt = at;
  }
  if (row.reverted !== undefined) {
    if (typeof row.reverted !== 'boolean') return false;
    into.reverted = row.reverted;
  }
  if (row.impact !== undefined) {
    const impact = measurement(row.impact);
    if (impact === null) return false;
    into.impact = impact;
  }
  if (row.pr !== undefined) {
    if (typeof row.pr !== 'string' || !PR_IDENT.test(row.pr) || row.pr.length > 256) return false;
    into.pr = row.pr.toLowerCase();
  }
  if (row.repo !== undefined) {
    if (typeof row.repo !== 'string' || !REPO_IDENT.test(row.repo) || row.repo.length > 256) return false;
    into.repo = row.repo.toLowerCase();
  }
  if (row.title !== undefined) {
    const title = text(row.title);
    if (title === null) return false;
    into.title = title;
  }
  return true;
}

/** A jobs.jsonl row must carry schemaVersion, id, lane and tier. */
function parseJobRow(row: Record<string, unknown>): RouterQueueJob | null {
  if (row.schemaVersion !== 1) return null;
  const id = ident(row.id);
  const lane = ident(row.lane);
  const tier = ident(row.tier);
  if (id === null || lane === null || tier === null) return null;
  const job: RouterQueueJob = { id, lane, tier };
  if (!overlayFields(row, job)) return null;
  return job;
}

// ---------------------------------------------------------------------------
// Bounded file read: regular file only, no symlinks, size-capped, UTF-8.
// ---------------------------------------------------------------------------

function readBoundedFile(path: string): { ok: true; text: string; bytes: number; mtimeMs: number } | { ok: false; state: 'missing' | 'unsafe' | 'invalid' } {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return { ok: false, state: 'unsafe' };
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) return { ok: false, state: 'unsafe' };
      offset += count;
    }
    const text = buffer.toString('utf8');
    // Replacement characters mean the bytes were not the producer's UTF-8.
    if (text.includes('�')) return { ok: false, state: 'invalid' };
    return { ok: true, text, bytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return { ok: false, state: 'missing' };
    }
    return { ok: false, state: 'unsafe' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function emptyRead(state: RouterQueueFileState, detail: string): RouterQueueFileRead {
  return { state, bytes: null, sha256: null, mtimeMs: null, rowsRead: 0, rowsDropped: 0, detail };
}

// ---------------------------------------------------------------------------
// Public read
// ---------------------------------------------------------------------------

/**
 * Read `queueDir/jobs.jsonl` + `queueDir/status.json`. Never throws, never
 * writes. `jobs` carries merged rows only when at least the jobs file parsed;
 * per-file states describe exactly what was served.
 */
export function readRouterQueue(queueDir: string): RouterQueueSnapshot {
  const jobsPath = join(queueDir, 'jobs.jsonl');
  const statusPath = join(queueDir, 'status.json');

  // ── jobs.jsonl ──────────────────────────────────────────────────────────
  const jobsFile: RouterQueueFileRead = { ...emptyRead('missing', 'jobs log not found') };
  const jobs = new Map<string, RouterQueueJob>();
  const jobsRead = readBoundedFile(jobsPath);
  if (!jobsRead.ok) {
    jobsFile.state = jobsRead.state;
    jobsFile.detail = jobsRead.state === 'missing' ? 'jobs log not found'
      : jobsRead.state === 'unsafe' ? 'jobs log not a safe regular file'
      : 'jobs log is not clean UTF-8';
  } else {
    jobsFile.state = 'ok';
    jobsFile.bytes = jobsRead.bytes;
    jobsFile.sha256 = sha256(jobsRead.text);
    jobsFile.mtimeMs = jobsRead.mtimeMs;
    jobsFile.detail = 'jobs log read';
    for (const line of jobsRead.text.split('\n')) {
      if (!line.trim()) continue;
      jobsFile.rowsRead += 1;
      let row: unknown;
      try { row = JSON.parse(line); } catch { jobsFile.rowsDropped += 1; continue; }
      if (!isRow(row)) { jobsFile.rowsDropped += 1; continue; }
      const job = parseJobRow(row);
      if (job === null || jobs.has(job.id) || jobs.size >= MAX_JOBS) {
        jobsFile.rowsDropped += 1;
        continue;
      }
      jobs.set(job.id, job);
    }
  }

  // ── status.json (overlay) ───────────────────────────────────────────────
  const statusFile: RouterQueueStatusRead = { ...emptyRead('missing', 'status snapshot not found'), applied: 0, hashMatched: null };
  const statusRead = readBoundedFile(statusPath);
  if (!statusRead.ok) {
    statusFile.state = statusRead.state;
    statusFile.detail = statusRead.state === 'missing' ? 'status snapshot not found'
      : statusRead.state === 'unsafe' ? 'status snapshot not a safe regular file'
      : 'status snapshot is not clean UTF-8';
  } else {
    statusFile.bytes = statusRead.bytes;
    statusFile.sha256 = sha256(statusRead.text);
    statusFile.mtimeMs = statusRead.mtimeMs;
    let parsed: unknown;
    try { parsed = JSON.parse(statusRead.text); } catch { parsed = null; }
    if (!isRow(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs)) {
      statusFile.state = 'invalid';
      statusFile.detail = 'status snapshot is not a schema-v1 object';
    } else if (typeof parsed.jobsSha256 !== 'string' || parsed.jobsSha256 !== jobsFile.sha256) {
      // A torn writer pair or a stale overlay: the jobs rows still serve.
      statusFile.state = 'invalid';
      statusFile.hashMatched = false;
      statusFile.detail = 'status snapshot does not match the jobs bytes read';
    } else {
      statusFile.state = 'ok';
      statusFile.hashMatched = true;
      statusFile.detail = 'status overlay applied';
      const seen = new Set<string>();
      for (const entry of parsed.jobs.slice(0, MAX_JOBS)) {
        statusFile.rowsRead += 1;
        if (!isRow(entry)) { statusFile.rowsDropped += 1; continue; }
        const id = ident(entry.id);
        const old = id !== null ? jobs.get(id) : undefined;
        if (id === null || old === undefined || seen.has(id)) { statusFile.rowsDropped += 1; continue; }
        // Identity fields and terminal facts cannot be contradicted.
        if (entry.lane !== undefined && entry.lane !== old.lane) { statusFile.rowsDropped += 1; continue; }
        if (entry.tier !== undefined && entry.tier !== old.tier) { statusFile.rowsDropped += 1; continue; }
        const update: Partial<RouterQueueJob> = {};
        if (!overlayFields(entry, update)) { statusFile.rowsDropped += 1; continue; }
        if (isComplete(old) && update.outcome !== undefined && update.outcome !== old.outcome) { statusFile.rowsDropped += 1; continue; }
        if (old.pr !== undefined && update.pr !== undefined && old.pr !== update.pr) { statusFile.rowsDropped += 1; continue; }
        if (old.reverted === true && update.reverted === false) { statusFile.rowsDropped += 1; continue; }
        seen.add(id);
        jobs.set(id, { ...old, ...update });
        statusFile.applied += 1;
      }
    }
  }

  // ── Merge-evidence invariants on the combined rows ─────────────────────
  // Merge-only fields on a non-merged job, a merge before its start, and PRs
  // claimed twice are dropped as rows, matching the interchange contract.
  const prs = new Set<string>();
  const rows: RouterQueueJob[] = [];
  for (const job of jobs.values()) {
    if (job.startedAt !== undefined && job.mergedAt !== undefined && job.mergedAt < job.startedAt) {
      jobsFile.rowsDropped += 1;
      continue;
    }
    if (job.outcome === 'merged') {
      if (job.pr === undefined || prs.has(job.pr)) { jobsFile.rowsDropped += 1; continue; }
      prs.add(job.pr);
    } else if (job.mergedAt !== undefined || job.reverted !== undefined || job.impact !== undefined) {
      jobsFile.rowsDropped += 1;
      continue;
    }
    rows.push(job);
  }
  if (jobsFile.state === 'ok' && jobsFile.rowsDropped > 0) jobsFile.detail = 'jobs log read with dropped rows';

  const state: RouterQueueSnapshot['state'] =
    jobsFile.state !== 'ok' ? jobsFile.state
      : statusFile.state === 'ok' || statusFile.state === 'missing' ? 'ok'
        : 'partial';
  return { jobs: rows, jobsFile, statusFile, state };
}

/** Default queue directory: `~/.ashlr-runs/queue` (override: ASHLR_RUNS_DIR). */
export function routerQueueDir(env: NodeJS.ProcessEnv = process.env, home: string | null = null): string {
  const base = typeof env['ASHLR_RUNS_DIR'] === 'string' && env['ASHLR_RUNS_DIR'].length > 0
    ? env['ASHLR_RUNS_DIR']
    : join(home ?? (env['HOME'] || ''), '.ashlr-runs');
  return join(base, 'queue');
}
