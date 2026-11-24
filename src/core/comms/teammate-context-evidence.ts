/**
 * Per-source freshness attribution for the teammate operational context.
 *
 * The context builder used to prefix one assembly timestamp and then present
 * every record as if equally current. These helpers keep the assembly time
 * distinct from each source's own observed file time, and label live status
 * records stale once they age past TEAMMATE_LIVE_STATUS_STALE_MS instead of
 * letting stale records read as current.
 */
import { constants as fsConstants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubSecrets } from '../util/scrub.js';

/**
 * Live status records older than this are labeled `stale`, never `fresh`.
 * dispatchd rewrites queue/status.json about once a minute and the main
 * guardian rewrites supervisor/status-main-guardian.md on each pass, so a
 * 30-minute-old file means the writer is down; the threshold matches the
 * guardian health check (MAIN_HEALTH_STALE_MS in core/fleet/main-health.ts).
 */
export const TEAMMATE_LIVE_STATUS_STALE_MS = 30 * 60_000;

const SOURCE_MAX_BYTES = 128 * 1024;
const SOURCE_MAX_CHARS = 1200;
export const CONTEXT_MAX_CHARS = 20000;
const VITALS_MAX_CHARS = 14000;
const TAIL_READ_BYTES = 96 * 1024;
/** Hard ceiling on any tail read, whatever a caller asks for. */
export const TAIL_MAX_READ_BYTES = 256 * 1024;
/** Only the newest lines of a ledger reach the prompt. */
export const TAIL_MAX_LINES = 40;

type SourceKind = 'durable' | 'status';

interface ContextSource {
  relative: string;
  kind: SourceKind;
}

/** VISION.md is durable context: it informs but is never live status. */
const CONTEXT_SOURCES: readonly ContextSource[] = [
  { relative: 'leader/VISION.md', kind: 'durable' },
  { relative: 'supervisor/status-main-guardian.md', kind: 'status' },
  { relative: 'queue/status.json', kind: 'status' },
];

interface SourceRead {
  text: string | null;
  observedMs: number | null;
  state: 'present' | 'missing' | 'unavailable';
}

function readSource(runsDir: string, relative: string): SourceRead {
  const file = join(runsDir, relative);
  if (!existsSync(file)) return { text: null, observedMs: null, state: 'missing' };
  const result = readStableRegularFile(file, {
    anchorPath: runsDir,
    maxFileBytes: SOURCE_MAX_BYTES,
    remainingBytes: SOURCE_MAX_BYTES,
  });
  if (!result.ok || !Number.isFinite(result.mtimeMs)) {
    return { text: null, observedMs: null, state: 'unavailable' };
  }
  return { text: result.text, observedMs: result.mtimeMs, state: 'present' };
}

function formatAge(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.round(abs / 1000)}s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
  return `${(abs / 3_600_000).toFixed(1)}h`;
}

function observedStamp(ms: number | null): string {
  return ms === null ? 'unknown' : new Date(ms).toISOString();
}

function attributionLine(source: ContextSource, read: SourceRead, nowMs: number): string {
  const kindLabel = source.kind === 'durable'
    ? 'durable context, not live status'
    : 'status record';
  const observed = `file observed ${observedStamp(read.observedMs)}`;
  if (read.state === 'missing') return `state: missing`;
  if (read.state === 'unavailable') return `state: unavailable; ${observed}`;
  if (source.kind === 'durable') return `state: present; ${observed}; ${kindLabel}`;
  const ageMs = nowMs - (read.observedMs ?? nowMs);
  const freshness = ageMs > TEAMMATE_LIVE_STATUS_STALE_MS ? 'stale' : 'fresh';
  return `state: ${freshness}; ${observed}; age ${formatAge(ageMs)} (stale after ${formatAge(TEAMMATE_LIVE_STATUS_STALE_MS)}); ${kindLabel}`;
}

interface StatusLane {
  running?: number;
  target?: number;
  floor?: number;
  ceiling?: number;
  hard_cap?: number;
  held?: boolean;
  queued?: number;
}

interface StatusJson {
  last_tick?: string;
  queue_depth?: number;
  paused?: unknown;
  mem_free_pct?: number;
  swap_gb?: number;
  launched_this_tick?: string[];
  kept_worktrees?: unknown;
  admission?: {
    admit?: boolean;
    gate_reason?: string | null;
    load1?: number;
    load_max?: number;
    procs?: number;
    worktrees?: number;
    warnings?: string[];
  };
  lanes?: Record<string, StatusLane>;
  recent_publishes?: Array<{ job?: string; url?: string }>;
  publishes_24h?: number;
  recent_events?: string[];
  rollup_24h?: { by_lane?: Record<string, { jobs?: number; merged?: number; merged_prs?: number }> };
  budget?: Record<string, {
    weekly_used_pct?: number;
    reset_at?: string;
    stale?: boolean;
    credits_remaining?: number | null;
    projected_exhaustion?: string | null;
  }>;
  autopilot?: { disk?: { free_gb?: number; lane_disk_gate?: string } };
}

function safeTailFile(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n
    && (process.platform === 'win32' || typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid()))
    && (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

/**
 * Resolve `relative` under runsDir and prove it stays there: no absolute or
 * `..` segments, the real parent directory is runsDir's real path or inside
 * it, and the final component is not a symlink. Returns null when unsafe.
 */
function containedRunsPath(runsDir: string, relative: string): string | null {
  try {
    if (isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part === '')) return null;
    const realRuns = realpathSync(resolve(runsDir));
    const file = join(resolve(runsDir), relative);
    const realParent = realpathSync(dirname(file));
    if (realParent !== realRuns && !realParent.startsWith(realRuns + sep)) return null;
    const candidate = join(realParent, file.slice(dirname(file).length + 1));
    const nested = relativePath(realRuns, candidate);
    if (nested === '' || nested.startsWith('..') || isAbsolute(nested)) return null;
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Read only the last maxBytes (capped at TAIL_MAX_READ_BYTES) and the last
 * maxLines of a regular file inside runsDir; dispatch logs reach tens of MB so
 * readStableRegularFile's whole-file byte cap cannot tail them. The path is
 * realpath-contained in runsDir, symlinks are refused by lstat and O_NOFOLLOW,
 * the opened inode must match the inspected one, and any error returns null.
 */
export function tailRunsFile(runsDir: string, relative: string, maxBytes: number, maxLines: number = TAIL_MAX_LINES): string | null {
  let fd: number | undefined;
  try {
    const file = containedRunsPath(runsDir, relative);
    if (file === null) return null;
    const before = lstatSync(file, { bigint: true });
    if (!safeTailFile(before)) return null;
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!safeTailFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const cap = Math.max(0, Math.min(Number.isSafeInteger(maxBytes) ? maxBytes : 0, TAIL_MAX_READ_BYTES));
    const size = Number(opened.size);
    const start = Math.max(0, size - cap);
    const buf = Buffer.alloc(size - start);
    const count = buf.length > 0 ? readSync(fd, buf, 0, buf.length, start) : 0;
    let text = buf.subarray(0, count).toString('utf8');
    const nl = text.indexOf('\n');
    if (start > 0) text = nl >= 0 ? text.slice(nl + 1) : '';
    const lines = text.trimEnd().split('\n');
    const keep = Math.max(0, Number.isSafeInteger(maxLines) ? maxLines : TAIL_MAX_LINES);
    return lines.slice(-keep).join('\n');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Remove query strings and fragments from every scheme URL in `text`; they
 * can carry tokens or signed parameters and never belong in a model prompt.
 */
export function stripUrlQueries(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>|)\]]+/gi, url => url.replace(/[?#].*$/, ''));
}

function sanitizedTail(text: string, keepChars: number): string {
  const sanitized = stripUrlQueries(text);
  if (sanitized.length <= keepChars) return sanitized;
  const start = sanitized.length - keepChars;
  const tail = sanitized.slice(start);
  return /\s/.test(sanitized[start - 1]) ? tail : tail.replace(/^\S+/, '');
}

/** Publish rows keep only an exact GitHub pull/issue URL; anything else is dropped. */
function publishUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const bare = stripUrlQueries(url.trim());
  return /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(pull|issues)\/\d+$/.test(bare) ? bare : '';
}

/** Parse a status record, returning null for malformed JSON or a non-object. */
export function parseStatusRecord(text: string | null): StatusJson | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as StatusJson : null;
  } catch {
    return null;
  }
}

function fmtNum(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '?';
}

/**
 * Derived fleet vitals: a compact digest of the dispatcher's own records so the
 * responder can answer lane/queue/launch/publish questions instead of reporting
 * that scheduler logs are unreadable. Every figure comes straight from
 * queue/status.json, queue/admission.json and the tail of the dispatch ledgers;
 * nothing here is estimated.
 */
export function fleetVitalsDigest(runsDir: string): string {
  const parts: string[] = [];
  const statusRead = readSource(runsDir, 'queue/status.json');
  const st = parseStatusRecord(statusRead.text);
  if (statusRead.text !== null && st !== null) {
    try {
      const lines: string[] = [];
      lines.push(`tick=${st.last_tick ?? '?'} queue_depth=${st.queue_depth ?? '?'} paused=${JSON.stringify(st.paused ?? null)} mem_free=${fmtNum(st.mem_free_pct)}% swap_gb=${fmtNum(st.swap_gb)} launched_this_tick=${JSON.stringify(st.launched_this_tick ?? [])}`);
      const adm = st.admission;
      if (adm && typeof adm === 'object') {
        lines.push(`admission: admit=${adm.admit ?? '?'} gate=${adm.gate_reason ?? 'none'} load1=${fmtNum(adm.load1)}/${fmtNum(adm.load_max)} procs=${adm.procs ?? '?'} worktrees=${adm.worktrees ?? '?'} warnings=${(adm.warnings ?? []).join('; ') || 'none'}`);
      }
      for (const [name, lane] of Object.entries(st.lanes ?? {})) {
        if (!lane || typeof lane !== 'object') continue;
        lines.push(`lane ${name}: running=${lane.running ?? '?'} target=${lane.target ?? '?'} floor=${lane.floor ?? '?'} cap=${lane.hard_cap ?? lane.ceiling ?? '?'} queued=${lane.queued ?? '?'}${lane.held ? ' HELD' : ''}`);
      }
      const budget = st.budget;
      if (budget && typeof budget === 'object') {
        const entries = Object.entries(budget)
          .map(([name, b]) => {
            if (!b || typeof b !== 'object') return null;
            const parts = [`${name}:used=${fmtNum(b.weekly_used_pct)}%`];
            if (b.reset_at) parts.push(`reset=${String(b.reset_at).slice(0, 16)}`);
            if (b.stale) parts.push('STALE');
            if (b.credits_remaining != null) parts.push(`credits=${b.credits_remaining}`);
            if (b.projected_exhaustion) parts.push(`exhausts=${String(b.projected_exhaustion).slice(0, 16)}`);
            return parts.join(' ');
          })
          .filter((line): line is string => line !== null)
          .slice(0, 14);
        if (entries.length > 0) lines.push(`budget: ${entries.join(' | ')}`);
      }
      const disk = st.autopilot?.disk;
      if (disk && typeof disk === 'object') {
        lines.push(`disk: free_gb=${fmtNum(disk.free_gb)} lane_gate=${disk.lane_disk_gate ?? '?'}`);
      }
      const pubs = (st.recent_publishes ?? []).slice(0, 8);
      if (pubs.length > 0) {
        lines.push(`recent publishes (${st.publishes_24h ?? '?'} in 24h): ${pubs.map(p => `${p?.job ?? '?'} ${publishUrl(p?.url)}`.trim()).join(' | ')}`);
      }
      const events = (st.recent_events ?? []).slice(-14);
      if (events.length > 0) lines.push(`recent events: ${events.join(' | ')}`);
      const byLane = st.rollup_24h?.by_lane;
      if (byLane && typeof byLane === 'object') {
        const tops = Object.entries(byLane)
          .map(([name, v]) => `${name}:jobs=${v.jobs ?? 0},merged=${v.merged ?? v.merged_prs ?? 0}`)
          .slice(0, 14);
        if (tops.length > 0) lines.push(`24h rollup: ${tops.join(' | ')}`);
      }
      parts.push(`fleet vitals (queue/status.json digest):\n${lines.join('\n')}`);
    } catch {
      parts.push('fleet vitals (queue/status.json digest): status.json present but unparseable');
    }
  } else if (statusRead.text !== null) {
    parts.push('fleet vitals (queue/status.json digest): status.json present but unparseable');
  } else {
    parts.push(`fleet vitals (queue/status.json digest): ${statusRead.state === 'missing' ? 'missing' : 'unavailable'}`);
  }
  for (const [label, relative, keepChars] of [
    ['dispatch-events tail', 'dispatch-events.log', 5000],
    ['dispatchd tail', 'dispatchd.log', 3500],
    ['jobs.jsonl tail', 'metrics/jobs.jsonl', 4500],
  ] as const) {
    const tail = tailRunsFile(runsDir, relative, TAIL_READ_BYTES, TAIL_MAX_LINES);
    if (tail !== null && tail.length > 0) parts.push(`${label}:\n${sanitizedTail(tail, keepChars)}`);
  }
  return stripUrlQueries(parts.join('\n')).slice(0, VITALS_MAX_CHARS);
}

/**
 * Bounded context projection. Every source's attribution line precedes its
 * claims, so the character cap can truncate content but never orphan a
 * source's claims from its stale/unknown label. `nowMs` is injected so tests
 * are deterministic; production callers pass Date.now().
 */
export function buildTeammateOperationalContext(runsDir: string, nowMs: number): string {
  const sections: string[] = [
    `Context assembled: ${new Date(nowMs).toISOString()} (assembly time; each source's file time is listed with it)`,
    `Responder source: ${process.env.PHANTOM_COMMS_SOURCE_SHA ?? 'unknown'}`,
    `Installed desktop version: ${process.env.PHANTOM_COMMS_DESKTOP_VERSION ?? 'unknown'}`,
    '',
  ];
  for (const source of CONTEXT_SOURCES) {
    const read = readSource(runsDir, source.relative);
    sections.push(`## ${source.relative}: ${attributionLine(source, read, nowMs)}`);
    if (read.text !== null) sections.push(read.text.slice(0, SOURCE_MAX_CHARS));
    sections.push('');
  }
  const vitals = fleetVitalsDigest(runsDir);
  if (vitals.length > 0) {
    sections.push('## fleet vitals (derived digest of live queue/dispatch/job records):');
    sections.push(vitals);
    sections.push('');
  }
  return stripUrlQueries(scrubSecrets(sections.join('\n'))).slice(0, CONTEXT_MAX_CHARS);
}
