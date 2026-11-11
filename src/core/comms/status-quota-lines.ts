/**
 * Bounded subscription-quota projection for the status replies (Telegram,
 * email). The lane rows answer "what is the fleet doing"; these lines answer
 * Mason's other question — how much Codex or Claude is left and when it
 * resets — from the capacity snapshot the Verse server already publishes.
 * Local token counts are completed-job metrics; quota is provider windows.
 *
 * Honesty rules: a null usedPercent is "unknown", never zero; Claude's reset
 * prose stays words (never parsed into a time); a snapshot that stops
 * publishing reads as unavailable rather than zero; anything older than the
 * stale bound is flagged instead of passed off as current. All free text
 * (seat labels, window ids, provider reset wording) goes through
 * `scrubSecrets` before it can reach a chat reply.
 */
import { readCapacitySnapshot, type CapacitySnapshot } from '../routing/budget-store.js';
import type { CapacityWindow, SeatCapacity } from '../routing/headroom.js';
import { resetCountdown } from '../fleet/reset-countdown.js';
import { scrubSecrets } from '../util/scrub.js';

const MAX_SEATS = 8;
const MAX_LINE_CHARS = 160;
const MAX_LABEL_CHARS = 48;
const MAX_DESCRIPTION_CHARS = 80;
const STALE_AFTER_MS = 30 * 60_000;
/**
 * Claude's 5-hour/session window is not subscription capacity for this
 * report (standing priority 3 — same exclusion fleet/graph-live.ts applies
 * to the usage graph). Weekly windows, including the per-model `seven_day_*`
 * readings, stay.
 */
const CLAUDE_SESSION_WINDOW_IDS = new Set(['five_hour', 'session']);

/**
 * The freshest observation the snapshot carries: each seat's own observedAt
 * when it offers one, the snapshot's publishedAt otherwise. Null when no
 * timestamp parses — the caller then cannot prove the data is stale.
 */
function snapshotAgeMs(snapshot: CapacitySnapshot, nowMs: number): number | null {
  const published = Date.parse(snapshot.publishedAt);
  let freshest = Number.NEGATIVE_INFINITY;
  for (const seat of snapshot.seats) {
    const observed = typeof seat?.observedAt === 'string' ? Date.parse(seat.observedAt) : NaN;
    const stamp = Number.isFinite(observed) ? observed : published;
    if (Number.isFinite(stamp) && stamp > freshest) freshest = stamp;
  }
  if (!Number.isFinite(freshest) && Number.isFinite(published)) freshest = published;
  return Number.isFinite(freshest) ? nowMs - freshest : null;
}

function seatName(seat: SeatCapacity): string {
  const raw = typeof seat?.label === 'string' && seat.label.length > 0
    ? seat.label
    : typeof seat?.seatId === 'string' ? seat.seatId : 'unknown';
  const clean = scrubSecrets(raw).slice(0, MAX_LABEL_CHARS).trim();
  return clean.length > 0 ? clean : 'unknown';
}

/** One `<window>: <used>% · <reset>` segment, scrubbed and bounded. */
function windowText(window: CapacityWindow, nowMs: number): string {
  const id = scrubSecrets(String(window?.id ?? 'window')).slice(0, 64).trim() || 'window';
  const pct = window.usedPercent;
  const used = typeof pct === 'number' && Number.isFinite(pct)
    ? `${Math.max(0, Math.min(100, Math.round(pct)))}%`
    : 'unknown';
  let reset = 'reset unknown';
  if (typeof window.resetsAt === 'string' && window.resetsAt.length > 0) {
    reset = resetCountdown(window.resetsAt, nowMs);
  } else if (typeof window.resetDescription === 'string' && window.resetDescription.trim().length > 0) {
    reset = scrubSecrets(window.resetDescription).slice(0, MAX_DESCRIPTION_CHARS).trim() || 'reset unknown';
  }
  return `${id}: ${used} · ${reset}${window.limitReached === true ? ' (limit reached)' : ''}`;
}

function seatLine(seat: SeatCapacity, nowMs: number): string {
  const windows = (Array.isArray(seat?.windows) ? seat.windows : [])
    .filter((window) => window !== null && typeof window === 'object')
    .filter((window) => !(seat?.engine === 'claude' && CLAUDE_SESSION_WINDOW_IDS.has(window.id)));
  const detail = windows.length === 0
    ? 'no windows reported'
    : windows.map((window) => windowText(window, nowMs)).join('; ');
  const line = `Quota ${seatName(seat)}: ${detail}`;
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

/**
 * One line per seat (at most 8, each at most 160 chars):
 * `Quota <seat label or seatId>: <window>: <used>% · <reset>; <window>: ...`
 * A snapshot older than 30 minutes is prefixed `Quota (stale, read <N>m ago):`;
 * no snapshot at all reads as the desktop being off, not as zero usage.
 */
export function quotaLines(snapshot: CapacitySnapshot | null, nowMs: number): string[] {
  if (!snapshot || !Array.isArray(snapshot.seats)) return ['Quota: unavailable (Phantom desktop not running)'];
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const lines = snapshot.seats.slice(0, MAX_SEATS).map((seat) => seatLine(seat, now));
  if (lines.length === 0) lines.push('Quota: no seats reported');
  const age = snapshotAgeMs(snapshot, now);
  if (age !== null && age > STALE_AFTER_MS) {
    lines.unshift(`Quota (stale, read ${Math.round(age / 60_000)}m ago):`);
  }
  return lines;
}

/** The status-reply seam: read the published snapshot, never throw. */
export function readQuotaLines(nowMs: number): string[] {
  try {
    return quotaLines(readCapacitySnapshot(), nowMs);
  } catch {
    return ['Quota: unavailable'];
  }
}

/**
 * Output-boundary projection for injected readers, same contract the supply
 * lines hold: an array of short scrubbed strings or a single unavailable line.
 */
export function boundedQuotaLines(value: unknown): string[] {
  if (!Array.isArray(value)) return ['Quota: unavailable'];
  const lines = value
    .filter((line): line is string => typeof line === 'string')
    .slice(0, MAX_SEATS + 1)
    .map((line) => scrubSecrets(line).slice(0, MAX_LINE_CHARS));
  return lines.length > 0 ? lines : ['Quota: unavailable'];
}
