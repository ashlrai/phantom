/**
 * Per-source freshness attribution for the teammate operational context.
 *
 * The context builder used to prefix one assembly timestamp and then present
 * every record as if equally current. These helpers keep the assembly time
 * distinct from each source's own observed file time, and label live status
 * records stale once they age past TEAMMATE_LIVE_STATUS_STALE_MS instead of
 * letting stale records read as current.
 */
import { constants as fsConstants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';
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
}

function safeTailFile(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n
    && (process.platform === 'win32' || typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid()))
    && (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

/**
 * Read only the last maxBytes of a regular file; dispatch logs reach tens of MB
 * so readStableRegularFile's whole-file byte cap cannot tail them. Applies the
 * same ownership/link/mode discipline as the stable reader before opening.
 */
function tailRegularFile(file: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(file, { bigint: true });
    if (!safeTailFile(before)) return null;
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!safeTailFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const size = Number(opened.size);
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    if (start > 0 && nl >= 0) text = text.slice(nl + 1);
    return text.trimEnd();
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
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
function fleetVitalsDigest(runsDir: string): string {
  const parts: string[] = [];
  const statusRead = readSource(runsDir, 'queue/status.json');
  if (statusRead.text !== null) {
    try {
      const st = JSON.parse(statusRead.text) as StatusJson;
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
      const pubs = (st.recent_publishes ?? []).slice(0, 8);
      if (pubs.length > 0) {
        lines.push(`recent publishes (${st.publishes_24h ?? '?'} in 24h): ${pubs.map(p => `${p.job ?? '?'} ${p.url ?? ''}`.trim()).join(' | ')}`);
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
  } else {
    parts.push(`fleet vitals (queue/status.json digest): ${statusRead.state === 'missing' ? 'missing' : 'unavailable'}`);
  }
  for (const [label, relative, keepChars] of [
    ['dispatch-events tail', 'dispatch-events.log', 5000],
    ['dispatchd tail', 'dispatchd.log', 3500],
    ['jobs.jsonl tail', 'metrics/jobs.jsonl', 4500],
  ] as const) {
    const tail = tailRegularFile(join(runsDir, relative), TAIL_READ_BYTES);
    if (tail !== null && tail.length > 0) parts.push(`${label}:\n${tail.slice(-keepChars)}`);
  }
  return parts.join('\n').slice(0, VITALS_MAX_CHARS);
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
  return scrubSecrets(sections.join('\n')).slice(0, CONTEXT_MAX_CHARS);
}
