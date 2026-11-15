/**
 * Per-source freshness attribution for the teammate operational context.
 *
 * The context builder used to prefix one assembly timestamp and then present
 * every record as if equally current. These helpers keep the assembly time
 * distinct from each source's own observed file time, and label live status
 * records stale once they age past TEAMMATE_LIVE_STATUS_STALE_MS instead of
 * letting stale records read as current.
 */
import { existsSync } from 'node:fs';
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
const CONTEXT_MAX_CHARS = 4000;

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

/**
 * Bounded context projection. Every source's attribution line precedes its
 * claims, so the 4000-character cap can truncate content but never orphan a
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
  return scrubSecrets(sections.join('\n')).slice(0, CONTEXT_MAX_CHARS);
}
