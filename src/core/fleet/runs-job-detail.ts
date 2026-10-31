/**
 * runs-job-detail.ts — RQ-PHX-JOBDETAIL: single-job detail projection
 * (`fleet.job.v1`), served by GET /api/fleet/job?id=<JOB> on the loopback
 * dashboard. When the live fleet view shows a job running, this answers
 * "what is it doing": provenance (lane/tier/model/branch), publish outcome,
 * and a scrubbed, bounded tail of the live or archived worker log.
 *
 * READ-ONLY GUARDRAILS (same contract as lane-console.ts):
 *  - Bounded fs reads only. Never writes, never spawns a child process,
 *    never touches credentials, provider endpoints or the network.
 *  - Every source is independently guarded: a missing or corrupt file
 *    degrades only its own slice — the detail never fabricates fields.
 *  - lstat before every read: symlinks are never followed; a linked file
 *    marks its source degraded instead of escaping runsDir.
 *  - Only the whitelisted `J.<suffix>` files below are ever opened —
 *    .token, .key, budget-overrides*, agent.sb and friends are never touched.
 *  - `J.prompt` contributes a byte size only; its contents never leave.
 *    The worktree path in `J.base` likewise never leaves (branch only).
 *  - Log tail lines are scrubbed: scrubSecrets, home-path redaction, then
 *    any line still naming a credential keyword collapses to
 *    '[redacted line]'.
 *
 * SOURCES (per job id J, all under runsDir — `~/.ashlr-runs` by default):
 *   J.launch      `launched J <lane> pid <pid> base <sha>`; mtime = launch time.
 *   J.base        first line `<sha> <branch> <worktree-path>`.
 *   J.base.meta   first line `MODEL <lane> <tier> <model> ...`.
 *   J.prompt      worker prompt — byte count only.
 *   J.log         live worker log; `J.log.gz` is its post-run archive.
 *   J.publish     bridge result text: `RESULT PR <url>`, `AUTO_MERGE on|off`,
 *                 `TEST <...>`, `SENS=[...]`.
 *   J.notes.md / J.body.md — bridge notes; booleans + byte size only.
 */

import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { createGunzip } from 'node:zlib';
import { redactHomePaths, scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Public types — the fleet.job.v1 wire shape.
// ---------------------------------------------------------------------------

export type FleetJobState = 'running' | 'published' | 'archived' | 'unknown';
export type FleetJobSourceState = 'healthy' | 'missing' | 'degraded';

export interface FleetJobDetailV1 {
  schema: 'fleet.job.v1';
  generatedAt: string;
  job: string;
  state: FleetJobState;
  lane: string | null;
  tier: string | null;
  model: string | null;
  pid: number | null;
  launchedAt: string | null;
  baseSha: string | null;
  branch: string | null;
  promptBytes: number | null;
  publish: {
    prUrl: string | null;
    autoMerge: boolean | null;
    testLine: string | null;
    sensitive: string[] | null;
  } | null;
  notes: { hasNotes: boolean; hasBody: boolean; notesBytes: number | null };
  log: {
    source: 'live' | 'archived' | 'missing';
    bytes: number | null;
    tail: string[];
    truncated: boolean;
  };
  sources: Record<'launch' | 'base' | 'meta' | 'publish' | 'log', FleetJobSourceState>;
}

export interface FleetJobDetailOptions {
  /** Runs directory. Default `~/.ashlr-runs`. Must be absolute when given. */
  runsDir?: string;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Tail lines returned for the job log. Default 120. */
  maxTailLines?: number;
  /** Read window from the end of a live log. Default 32 KiB. */
  maxTailBytes?: number;
}

// ---------------------------------------------------------------------------
// Constants and small guards
// ---------------------------------------------------------------------------

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const DEFAULT_TAIL_LINES = 120;
const DEFAULT_TAIL_BYTES = 32 * 1024;
const SMALL_READ_BYTES = 16 * 1024;
const PUBLISH_READ_BYTES = 64 * 1024;
const MAX_GZ_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GZ_OUTPUT_BYTES = 32 * 1024 * 1024;
const GZ_KEEP_CHARS = 256 * 1024;
const MAX_FIELD_CHARS = 512;
const SENSITIVE_LINE = /(token|secret|api[_-]?key|authorization|bearer)/i;
const REDACTED_LINE = '[redacted line]';

/** `launched J <lane> pid <pid> base <sha>` — lane charset mirrors lane-console LANE_ID. */
const LAUNCHED = /\blaunched\s+([A-Za-z0-9][A-Za-z0-9._-]{1,79})\s+([A-Za-z0-9][A-Za-z0-9._@-]{0,63})\s+pid\s+(\d+)\s+base\s+([0-9a-fA-F]{4,64})\b/g;

export function isFleetJobId(job: string): boolean {
  return JOB_ID.test(job);
}

/** Control bytes cannot survive into the projection; cap length per value. */
function cleanField(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control bytes is the point.
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_FIELD_CHARS);
}

function scrubField(value: string): string {
  return redactHomePaths(scrubSecrets(cleanField(value)));
}

function scrubLogLine(line: string): string {
  const cleaned = redactHomePaths(scrubSecrets(cleanField(line)));
  return SENSITIVE_LINE.test(cleaned) ? REDACTED_LINE : cleaned;
}

interface Probe {
  kind: 'file' | 'other' | 'missing' | 'error';
  size: number;
  /** lstat mtime; null when the lstat itself failed. */
  mtimeMs: number | null;
}

/** lstat only — a symlink or non-regular file is 'other', never followed. */
async function probe(path: string): Promise<Probe> {
  try {
    const st = await lstat(path);
    return { kind: st.isFile() ? 'file' : 'other', size: st.size, mtimeMs: st.mtimeMs };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error', size: 0, mtimeMs: null };
  }
}

const exists = (p: Probe) => p.kind !== 'missing';
const readable = (p: Probe) => p.kind === 'file';

/** Read up to maxBytes at byte offset. The only file-read primitive here. */
async function readSlice(path: string, size: number, offset: number, maxBytes: number): Promise<string> {
  const length = Math.max(0, Math.min(size - offset, maxBytes));
  if (length === 0) return '';
  const fh = await open(path);
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Decompress a .log.gz holding only a rolling tail window in memory.
 * `overCap` marks a decompression bomb (> MAX_GZ_OUTPUT_BYTES) — the retained
 * window is still served, marked truncated. Throws on a corrupt stream.
 */
async function readGzipTail(path: string): Promise<{ text: string; headDropped: boolean; overCap: boolean }> {
  const decoder = new TextDecoder();
  let text = '';
  let output = 0;
  let headDropped = false;
  let overCap = false;
  const source = createReadStream(path);
  const stream = source.pipe(createGunzip());
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      output += buf.length;
      if (output > MAX_GZ_OUTPUT_BYTES) { overCap = true; break; }
      text += decoder.decode(buf, { stream: true });
      if (text.length > GZ_KEEP_CHARS) {
        text = text.slice(-GZ_KEEP_CHARS);
        headDropped = true;
      }
    }
    text += decoder.decode();
  } finally {
    stream.destroy();
    source.destroy();
  }
  return { text, headDropped: headDropped || overCap, overCap };
}

/** Last maxLines complete lines of text, each scrubbed; drop a partial first line. */
function tailLines(text: string, dropFirst: boolean, maxLines: number): { lines: string[]; truncated: boolean } {
  let lines = text.split('\n');
  if (dropFirst && lines.length > 0) lines = lines.slice(1);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  const truncated = dropFirst || lines.length > maxLines;
  if (lines.length > maxLines) lines = lines.slice(-maxLines);
  return { lines: lines.map(scrubLogLine), truncated };
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

function parseLaunch(text: string, job: string): { lane: string | null; pid: number | null; baseSha: string | null; matched: boolean } {
  let lane: string | null = null;
  let pid: number | null = null;
  let baseSha: string | null = null;
  let matched = false;
  for (const m of text.matchAll(LAUNCHED)) {
    if (m[1] !== job) continue; // a launch record naming another job is not ours
    matched = true;
    lane = cleanField(m[2]!);
    pid = Number(m[3]);
    baseSha = cleanField(m[4]!);
  }
  if (!matched) {
    const p = text.match(/\bpid\s+(\d+)\b/);
    if (p) pid = Number(p[1]);
    const b = text.match(/\bbase\s+([0-9a-fA-F]{4,64})\b/);
    if (b) baseSha = cleanField(b[1]!);
  }
  return { lane, pid, baseSha, matched };
}

function parsePublish(text: string): NonNullable<FleetJobDetailV1['publish']> {
  const pr = text.match(/^RESULT\s+PR\s+(\S+)/m);
  const am = text.match(/^AUTO_MERGE\s+(on|off)\b/m);
  const test = text.match(/^TEST\b[^\n]*/m);
  const sens = text.match(/\bSENS=\[([^\]]*)\]/);
  return {
    prUrl: pr ? scrubField(pr[1]!) : null,
    autoMerge: am ? am[1] === 'on' : null,
    testLine: test ? scrubField(test[0].trim()) : null,
    sensitive: sens ? sens[1]!.split(/[\s,]+/).filter(Boolean).map(scrubField) : null,
  };
}

// ---------------------------------------------------------------------------
// Detail assembly — every source guarded; never throws on fs input.
// ---------------------------------------------------------------------------

export async function getFleetJobDetail(job: string, options: FleetJobDetailOptions = {}): Promise<FleetJobDetailV1> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new Error('runsDir must be an absolute path');
  const now = options.now?.() ?? new Date();
  const maxTailLines = options.maxTailLines ?? DEFAULT_TAIL_LINES;
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  const file = (suffix: string) => join(runsDir, `${job}.${suffix}`);

  const [pLaunch, pBase, pMeta, pPrompt, pLog, pLogGz, pPublish, pNotes, pBody] = await Promise.all(
    ['launch', 'base', 'base.meta', 'prompt', 'log', 'log.gz', 'publish', 'notes.md', 'body.md'].map(s => probe(file(s))),
  );

  const sources: FleetJobDetailV1['sources'] = {
    launch: 'missing', base: 'missing', meta: 'missing', publish: 'missing', log: 'missing',
  };

  // ── J.launch — lane/pid/base + launch time (mtime) ───────────────────────
  let launchLane: string | null = null;
  let pid: number | null = null;
  let launchSha: string | null = null;
  if (exists(pLaunch)) {
    sources.launch = 'degraded';
    if (readable(pLaunch)) {
      try {
        const parsed = parseLaunch(await readSlice(file('launch'), pLaunch.size, 0, SMALL_READ_BYTES), job);
        launchLane = parsed.lane;
        pid = parsed.pid;
        launchSha = parsed.baseSha;
        if (parsed.matched) sources.launch = 'healthy';
      } catch { /* stays degraded */ }
    }
  }

  // ── J.base — sha + branch (the worktree path never leaves this module) ───
  let baseSha: string | null = null;
  let branch: string | null = null;
  if (exists(pBase)) {
    sources.base = 'degraded';
    if (readable(pBase)) {
      try {
        const fields = firstLine(await readSlice(file('base'), pBase.size, 0, SMALL_READ_BYTES)).split(/\s+/);
        if (fields.length >= 2) {
          baseSha = cleanField(fields[0]!);
          branch = cleanField(fields[1]!);
          sources.base = 'healthy';
        }
      } catch { /* stays degraded */ }
    }
  }

  // ── J.base.meta — `MODEL <lane> <tier> <model> ...` ──────────────────────
  let metaLane: string | null = null;
  let tier: string | null = null;
  let model: string | null = null;
  if (exists(pMeta)) {
    sources.meta = 'degraded';
    if (readable(pMeta)) {
      try {
        const m = (await readSlice(file('base.meta'), pMeta.size, 0, SMALL_READ_BYTES)).match(/^MODEL\s+(\S+)\s+(\S+)\s+(\S+)/m);
        if (m) {
          metaLane = cleanField(m[1]!);
          tier = cleanField(m[2]!);
          model = cleanField(m[3]!);
          sources.meta = 'healthy';
        }
      } catch { /* stays degraded */ }
    }
  }

  // ── J.publish — bridge result; the object exists whenever the file does ──
  let publish: FleetJobDetailV1['publish'] = null;
  if (exists(pPublish)) {
    sources.publish = 'degraded';
    publish = { prUrl: null, autoMerge: null, testLine: null, sensitive: null };
    if (readable(pPublish)) {
      try {
        // RESULT/AUTO_MERGE/TEST/SENS lines are emitted at the end of the run.
        const start = Math.max(0, pPublish.size - PUBLISH_READ_BYTES);
        publish = parsePublish(await readSlice(file('publish'), pPublish.size, start, PUBLISH_READ_BYTES));
        sources.publish = 'healthy';
      } catch { /* stays degraded */ }
    }
  }

  // ── J.log / J.log.gz — scrubbed bounded tail ─────────────────────────────
  const log: FleetJobDetailV1['log'] = { source: 'missing', bytes: null, tail: [], truncated: false };
  if (readable(pLog)) {
    log.source = 'live';
    log.bytes = pLog.size;
    sources.log = 'degraded';
    try {
      const start = Math.max(0, pLog.size - maxTailBytes);
      const out = tailLines(await readSlice(file('log'), pLog.size, start, maxTailBytes), start > 0, maxTailLines);
      log.tail = out.lines;
      log.truncated = out.truncated;
      sources.log = 'healthy';
    } catch { /* stays degraded */ }
  } else if (readable(pLogGz)) {
    log.source = 'archived';
    log.bytes = pLogGz.size;
    sources.log = 'degraded';
    if (pLogGz.size > MAX_GZ_FILE_BYTES) {
      log.truncated = true; // over the read bound — never decompressed at all
    } else {
      try {
        const gz = await readGzipTail(file('log.gz'));
        const out = tailLines(gz.text, gz.headDropped, maxTailLines);
        log.tail = out.lines;
        log.truncated = out.truncated || gz.overCap;
        sources.log = gz.overCap ? 'degraded' : 'healthy';
      } catch { /* stays degraded */ }
    }
  } else if (exists(pLog) || exists(pLogGz)) {
    sources.log = 'degraded'; // a symlink or unreadable file — nothing was read
  }

  // ── state — existence + mtime ordering, per the documented semantics ──────
  const launchNewerThanPublish = pLaunch.mtimeMs !== null && (pPublish.mtimeMs === null || pLaunch.mtimeMs > pPublish.mtimeMs);
  const launchNewerThanGz = pLaunch.mtimeMs !== null && pLogGz.mtimeMs !== null && pLaunch.mtimeMs > pLogGz.mtimeMs;
  const state: FleetJobState =
    launchNewerThanPublish && exists(pLog) && !exists(pLogGz) ? 'running'
      : exists(pPublish) ? 'published'
        : exists(pLogGz) && !launchNewerThanGz ? 'archived'
          : 'unknown';

  return {
    schema: 'fleet.job.v1',
    generatedAt: now.toISOString(),
    job,
    state,
    lane: launchLane ?? metaLane,
    tier,
    model,
    pid,
    launchedAt: pLaunch.mtimeMs !== null ? new Date(pLaunch.mtimeMs).toISOString() : null,
    baseSha: baseSha ?? launchSha,
    branch,
    promptBytes: readable(pPrompt) ? pPrompt.size : null,
    publish,
    notes: {
      hasNotes: exists(pNotes),
      hasBody: exists(pBody),
      notesBytes: readable(pNotes) ? pNotes.size : null,
    },
    log,
    sources,
  };
}
