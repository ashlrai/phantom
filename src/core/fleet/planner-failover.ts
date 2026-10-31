/**
 * planner-failover.ts — read side and provider choice for running the fleet
 * planner on whichever login is live.
 *
 * WHY THIS EXISTS. On 2026-10-31 the hourly executor ran on a single Codex
 * account, hit that account's usage limit at 14:14 ET and failed every
 * fifteen minutes for hours — while each dispatch-events row still reported
 * `rc=0`. The events row cannot be trusted to flag the failure; the run log
 * can. This module reads both so a later change can pick a different login.
 *
 * SOURCES (read-only, bounded tails, symlinks refused — the same conventions
 * as runs-parked-queue.ts):
 *   - `<runsRoot>/queue/dispatch-events.log` (with a `<runsRoot>/dispatch-events.log`
 *     fallback: the codebase reads this file from both locations).
 *   - the newest `<runsRoot>/supervisor/run.*.log` by mtime.
 *
 * ROW-SHAPE CONVENTION (same one the incidents strip uses): a healthy pass
 * logs `LEADER fixups=N …` counter rows; a failed pass logs
 * `LEADER <executor> rc=N`. The rc VALUE is unreliable — a usage-limit death
 * was recorded as rc=0 — so the shape, not the number, marks the failure.
 * Any LEADER row not matching the `<executor> rc=` shape is a good pass.
 *
 * The run log is only consulted for the reason: a usage-limit signature
 * (isUsageLimitText — the single shared matcher, not a second copy) or an
 * advertised "try again at <date>" makes the failure `usage-limit` and
 * yields `resetAt`. The date is parsed strictly and stays null rather than
 * guessed. A `LEADER <executor> rc=` row with no exhaustion evidence is
 * still a failed pass — `executor-fail`.
 *
 * LaneHealth (drive/lane-health.ts) is deliberately not reused: it models
 * {reason, probeAtMs} for a single lane, while planner health needs a
 * status plus the failing-since/last-good/reset timestamps below.
 *
 * Pure apart from the file reads in readPlannerHealth itself. No CLI, no
 * route, no provider list hard-coded anywhere in this module.
 */
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isUsageLimitText } from '../classify/engine-errors.js';
import { localIso, localTimestamp, readSource, type Source } from './runs-parked-queue.js';

export type PlannerStatus = 'ok' | 'failing' | 'unknown';
export interface PlannerHealth {
  status: PlannerStatus;
  /** ISO of the oldest failed LEADER row in the newest failing streak; null unless failing. */
  failingSince: string | null;
  /** ISO of the newest good LEADER pass in the retained tail; null when none was read. */
  lastGoodPassAt: string | null;
  /** Account reset the newest run log advertises ("try again at …"), ISO; null when absent or unparseable. */
  resetAt: string | null;
  /** ok → null. failing → 'usage-limit' | 'executor-fail'.
   *  unknown → 'missing-events-log' | 'unreadable-events-log' | 'no-leader-rows'. */
  reason: string | null;
}
export interface PlannerCandidate { provider: string; argv: readonly string[] }
export type PlannerRunnerChoice =
  | { ok: true; provider: string; argv: readonly string[] }
  | { ok: false; reason: string; nextResetAt: string | null };

const MAX_EVENTS_TAIL = 256 * 1024;
const MAX_RUN_TAIL = 256 * 1024;
const MAX_RUN_CANDIDATES = 1024;
const EVENT_ROW = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z][A-Z0-9_-]{0,63})(?: (.*))?$/;
const LEADER_FAILED = /^\S+\s+rc=/;
const RUN_LOG = /^run\.[^/\\]*\.log$/;
const TRY_AGAIN = /try again at\s+([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?\s*,?\s*\d{4}\s+\d{1,2}:\d{2}(?:\s*[AaPp]\.?[Mm]\.?)?)/gi;
const RESET_PHRASE = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/;
const MONTHS: Readonly<Record<string, number>> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** Strict "Nov 4th, 2026 1:41 AM" parse in local time. No AM/PM, no guess — null. */
function parseResetPhrase(raw: string): string | null {
  const m = RESET_PHRASE.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
  const day = Number(m[2]);
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (month === undefined || day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return null;
  const date = new Date(year, month, day, (hour % 12) + (m[6]!.toLowerCase() === 'p' ? 12 : 0), minute);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return localIso(date);
}

/** Newest successfully parsed "try again at …" in the retained log tail, or null. */
function parseResetAt(text: string): string | null {
  let found: string | null = null;
  for (const match of text.matchAll(TRY_AGAIN)) {
    const parsed = parseResetPhrase(match[1]!);
    if (parsed !== null) found = parsed;
  }
  return found;
}

interface LeaderRow { ms: number; at: string; failed: boolean; order: number }

/** LEADER rows from the events tail, newest first (ms desc, file order breaks ties). */
function leaderRows(text: string, now: number): LeaderRow[] {
  const rows: LeaderRow[] = [];
  for (const line of text.split('\n')) {
    const m = EVENT_ROW.exec(line.replace(/\r$/, ''));
    if (!m || m[3] !== 'LEADER') continue;
    const timestamp = localTimestamp(`${m[1]} ${m[2]}`);
    if (!Number.isFinite(timestamp.ms) || timestamp.ms > now) continue;
    rows.push({ ms: timestamp.ms, at: timestamp.at, failed: LEADER_FAILED.test((m[4] ?? '').trim()), order: rows.length });
  }
  return rows.sort((a, b) => (b.ms - a.ms) || (b.order - a.order));
}

function assess(events: { state: Source; text: string }, runLogText: string, now: number): PlannerHealth {
  const rows = leaderRows(events.text, now);
  const newest = rows[0];
  const resetAt = parseResetAt(runLogText);
  if (!newest) {
    const reason = events.state === 'missing' ? 'missing-events-log'
      : events.state === 'degraded' ? 'unreadable-events-log' : 'no-leader-rows';
    return { status: 'unknown', failingSince: null, lastGoodPassAt: null, resetAt, reason };
  }
  if (!newest.failed) {
    return { status: 'ok', failingSince: null, lastGoodPassAt: newest.at, resetAt, reason: null };
  }
  let depth = 0;
  while (rows[depth + 1]?.failed) depth++;
  const usage = isUsageLimitText(runLogText) || resetAt !== null;
  return {
    status: 'failing',
    failingSince: rows[depth]!.at,
    lastGoodPassAt: rows[depth + 1]?.at ?? null,
    resetAt,
    reason: usage ? 'usage-limit' : 'executor-fail',
  };
}

/** The newest supervisor/run.*.log by mtime (name breaks ties), tail-bounded. */
async function newestRunLog(root: string): Promise<{ state: Source; text: string }> {
  const dir = join(root, 'supervisor');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => RUN_LOG.test(name)).slice(0, MAX_RUN_CANDIDATES);
  } catch (error) {
    return { state: missing(error) ? 'missing' : 'degraded', text: '' };
  }
  let best: { name: string; mtimeMs: number } | null = null;
  for (const name of names) {
    try {
      const info = await lstat(join(dir, name));
      if (!info.isFile()) continue;
      if (!best || info.mtimeMs > best.mtimeMs || (info.mtimeMs === best.mtimeMs && name > best.name)) {
        best = { name, mtimeMs: info.mtimeMs };
      }
    } catch { /* vanished between readdir and lstat */ }
  }
  return best ? readSource(join(dir, best.name), MAX_RUN_TAIL, true) : { state: 'missing', text: '' };
}

/**
 * Planner health from the runs dir. LEADER rows decide ok/failing/unknown;
 * the newest run log explains a failure and may advertise a reset time.
 */
export async function readPlannerHealth(
  runsRoot: string = join(homedir(), '.ashlr-runs'),
  now: number = Date.now(),
): Promise<PlannerHealth> {
  let events = await readSource(join(runsRoot, 'queue', 'dispatch-events.log'), MAX_EVENTS_TAIL, true);
  if (events.state === 'missing') {
    events = await readSource(join(runsRoot, 'dispatch-events.log'), MAX_EVENTS_TAIL, true);
  }
  const runLog = await newestRunLog(runsRoot);
  return assess(events, runLog.text, now);
}

/** A provider is limited while its health shows an unreset usage-limit failure. */
export function isProviderLimited(health: PlannerHealth | undefined, now: number): boolean {
  if (health?.status !== 'failing' || health.reason !== 'usage-limit') return false;
  const reset = health.resetAt === null ? Number.NaN : Date.parse(health.resetAt);
  // A missing or unparseable reset can never be proven past: still limited.
  return !Number.isFinite(reset) || reset > now;
}

/**
 * The first candidate whose provider is not usage-limited, in list order —
 * the caller's priority order. Providers failing for other reasons, unread
 * or unknown are not "limited": failover exists for exhausted logins, other
 * failure kinds stay the caller's problem. All limited (or none) → ok:false.
 */
export function selectPlannerRunner(
  candidates: readonly PlannerCandidate[],
  healthByProvider: Readonly<Record<string, PlannerHealth>>,
  now: number,
): PlannerRunnerChoice {
  let nextReset = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const health = healthByProvider[candidate.provider];
    if (!isProviderLimited(health, now)) return { ok: true, provider: candidate.provider, argv: candidate.argv };
    const reset = health.resetAt === null ? Number.NaN : Date.parse(health.resetAt);
    if (Number.isFinite(reset) && reset > now) nextReset = Math.min(nextReset, reset);
  }
  return {
    ok: false,
    reason: candidates.length > 0 ? 'all candidates are usage-limited' : 'no candidates',
    nextResetAt: Number.isFinite(nextReset) ? new Date(nextReset).toISOString() : null,
  };
}
