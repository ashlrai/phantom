/**
 * `phm fleet gaps`: every stretch of 15+ minutes with no dispatcher tick, or no launch while jobs were queued,
 * with the likely cause. Read-only. Ticks are the PLANNER_TICK lines in dispatch-events.log (they carry the
 * ready count and free slots); launches are the `launch` rows of metrics/jobs.jsonl. Sleep evidence is the
 * wall-clock jump between two clock samples a self-tick recorded: wall time minus monotonic time, which does
 * not advance while the Mac sleeps. Anything not measured is null / "unknown", never zero. A gap with an empty
 * queue on both edges is never called lost work.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dispatchEventsCandidates } from './dispatch-events-path.js';
import { ledgerRows } from './empty-cause.js';
import { localTimestamp } from './runs-parked-queue.js';

export const FLEET_GAPS_SCHEMA = 'fleet.gaps.v1';
export const GAP_MIN_MINUTES = 15;
/** A digest names only gaps longer than this. */
export const DIGEST_GAP_MINUTES = 30;
const MIN = 60_000;
/** Samples are written inside a tick, so they sit within minutes of that tick's log line. */
const SAMPLE_TOLERANCE_MS = 5 * MIN;
/** Under this a wall-minus-monotonic difference is timer jitter, not sleep. */
const SLEEP_NOISE_MS = 2 * MIN;
const MAX_SAMPLES = 400;
const CLOCK_FILE = 'queue/clock-samples.json';

export type GapCause = 'host-asleep' | 'dispatcher-stalled' | 'admission-blocked' | 'queue-empty' | 'unknown';

export interface ClockSample { wall: number; mono: number }
export interface Tick { at: number; run: boolean | null; reason: string | null; ready: number | null; free: number | null }

export interface FleetGap {
  start: string;
  end: string;
  minutes: number;
  /** no-tick: the dispatcher logged nothing. no-launch: ticks ran, jobs were queued, nothing started. */
  kind: 'no-tick' | 'no-launch';
  cause: GapCause;
  /** false only when the queue was empty; null when queue depth is unknown. */
  lostWork: boolean | null;
  jobsQueued: number | null;
  freeSlots: number | null;
  /** Minutes the clock samples show the Mac slept inside the gap; null when no pair of samples covers it. */
  sleptMinutes: number | null;
  /** Top skip reason for admission-blocked gaps. */
  reason: string | null;
  line: string;
}

export interface FleetGapsReport {
  schema: typeof FLEET_GAPS_SCHEMA;
  asOf: string;
  since: string;
  minMinutes: number;
  sources: { ticks: 'read' | 'unknown'; launches: 'read' | 'unknown'; clock: 'read' | 'unknown' };
  count: number | null;
  /** Minutes inside gaps where work was or may have been queued; null when ticks were unreadable. */
  lostMinutes: number | null;
  /** Claude weekly plan left, 0..100; null when unknown. */
  claudeLeftPct: number | null;
  gaps: FleetGap[];
}

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const etClock = (ms: number): string => ET.format(new Date(ms));

/** "6 hours", "45 minutes". */
export function span(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** The one plain sentence for a gap. */
export function gapLine(gap: Pick<FleetGap, 'cause' | 'minutes' | 'lostWork' | 'reason'>, startMs: number, endMs: number): string {
  const when = `${etClock(startMs)} to ${etClock(endMs)}`;
  const lost = gap.lostWork === false ? 'the queue was empty' : gap.lostWork === null ? 'whether work waited is unknown'
    : `${span(gap.minutes)} of work did not run`;
  switch (gap.cause) {
    case 'host-asleep': return `The Mac slept ${when}; ${lost}.`;
    case 'dispatcher-stalled': return `The dispatcher stalled ${when}; ${lost}.`;
    case 'admission-blocked': return `Launches were blocked ${when}${gap.reason ? ` (${gap.reason})` : ''}; ${lost}.`;
    case 'queue-empty': return `Nothing ran ${when}; the queue was empty.`;
    default: return `Nothing was recorded ${when}; the cause is unknown.`;
  }
}

/** Pure: PLANNER_TICK lines, oldest first. Lines with an unreadable stamp are skipped. */
export function parseTicks(text: string, now: number): Tick[] {
  const ticks: Tick[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+PLANNER_TICK\s+(run|skip)\b(.*)$/.exec(line);
    if (!m) continue;
    const at = localTimestamp(m[1]!).ms;
    if (!Number.isFinite(at) || at > now) continue;
    const num = (key: string): number | null => { const v = new RegExp(`\\b${key}=(\\d+)`).exec(m[3]!); return v ? Number(v[1]) : null; };
    ticks.push({ at, run: m[2] === 'run', reason: /\breason=(\S+)/.exec(m[3]!)?.[1] ?? null, ready: num('phx'), free: num('free') });
  }
  return ticks.sort((a, b) => a.at - b.at);
}

/** Pure: minutes slept between the sample at each gap edge, or null without a usable same-boot pair. */
function sleptBetween(samples: readonly ClockSample[], start: number, end: number): number | null {
  const before = [...samples].reverse().find(s => Math.abs(s.wall - start) <= SAMPLE_TOLERANCE_MS && s.wall <= end);
  const after = samples.find(s => Math.abs(s.wall - end) <= SAMPLE_TOLERANCE_MS && s.wall >= start);
  if (!before || !after || after.wall <= before.wall || after.mono < before.mono) return null;
  const slept = (after.wall - before.wall) - (after.mono - before.mono);
  return slept < SLEEP_NOISE_MS ? 0 : slept / MIN;
}

export interface BuildGapsInput {
  ticks: readonly Tick[] | null;
  launches: readonly number[] | null;
  samples: readonly ClockSample[] | null;
  now: number;
  since: number;
  minMinutes?: number;
  claudeLeftPct?: number | null;
}

/** Pure: the report from already-read evidence. */
export function buildFleetGaps(input: BuildGapsInput): FleetGapsReport {
  const minMs = (input.minMinutes ?? GAP_MIN_MINUTES) * MIN;
  const ticks = input.ticks, launches = input.launches ?? [], samples = input.samples ?? [];
  const gaps: FleetGap[] = [];
  const add = (start: number, end: number, kind: FleetGap['kind'], cause: GapCause, queued: number | null, free: number | null,
    slept: number | null, reason: string | null): void => {
    const s = Math.max(start, input.since);
    if (end - s < minMs) return;
    const minutes = Math.round((end - s) / MIN);
    const lostWork = cause === 'queue-empty' ? false : queued === null ? null : queued > 0;
    const gap = { start: new Date(s).toISOString(), end: new Date(end).toISOString(), minutes, kind, cause, lostWork,
      jobsQueued: queued, freeSlots: free, sleptMinutes: slept === null ? null : Math.round(slept), reason };
    gaps.push({ ...gap, line: gapLine(gap, s, end) });
  };
  if (ticks) {
    // Edges: the stretch since the last tick counts to now, so a stalled dispatcher shows before it recovers.
    for (let i = 0; i < ticks.length; i++) {
      const a = ticks[i]!, b: Tick | undefined = ticks[i + 1];
      const end = b?.at ?? input.now;
      if (end <= input.since) continue;
      if (end - a.at >= minMs) {
        const queued = a.ready === null ? null : b?.ready === undefined || b.ready === null ? a.ready : Math.max(a.ready, b.ready);
        const empty = a.ready === 0 && (b === undefined || b.ready === 0);
        const slept = b ? sleptBetween(samples, a.at, b.at) : null;
        const cause: GapCause = empty ? 'queue-empty' : slept === null ? 'unknown' : slept >= (end - a.at) / MIN / 2 ? 'host-asleep' : 'dispatcher-stalled';
        add(a.at, end, 'no-tick', cause, queued, a.free, slept, null);
      }
    }
    // No-launch runs: consecutive on-time ticks that all saw queued jobs and no launch between them.
    let run: Tick[] = [], runEnd = 0;
    const flush = (): void => {
      if (run.length && runEnd - run[0]!.at >= minMs) {
        const counts = new Map<string, number>();
        for (const t of run) if (t.run === false && t.reason) counts.set(t.reason, (counts.get(t.reason) ?? 0) + 1);
        const blocked = run.every(t => t.run === false);
        add(run[0]!.at, runEnd, 'no-launch', blocked ? 'admission-blocked' : 'unknown',
          Math.max(...run.map(t => t.ready ?? 0)), run[0]!.free, null, blocked ? ([...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null) : null);
      }
      run = [];
    };
    for (let i = 0; i < ticks.length; i++) {
      const a = ticks[i]!, b = ticks[i + 1];
      if (input.launches && b && b.at - a.at < minMs && a.ready && !launches.some(l => l >= a.at && l < b.at)) { run.push(a); runEnd = b.at; }
      else flush();
    }
    flush();
  }
  gaps.sort((x, y) => x.start.localeCompare(y.start));
  return {
    schema: FLEET_GAPS_SCHEMA, asOf: new Date(input.now).toISOString(), since: new Date(input.since).toISOString(),
    minMinutes: input.minMinutes ?? GAP_MIN_MINUTES,
    sources: { ticks: ticks ? 'read' : 'unknown', launches: input.launches ? 'read' : 'unknown', clock: input.samples ? 'read' : 'unknown' },
    count: ticks ? gaps.length : null,
    lostMinutes: ticks ? gaps.filter(g => g.lostWork !== false).reduce((n, g) => n + g.minutes, 0) : null,
    claudeLeftPct: input.claudeLeftPct ?? null,
    gaps,
  };
}

// ── clock samples (the only thing this module writes, and only from a real self-tick) ──────────────────────

export function readClockSamples(runsDir: string): ClockSample[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runsDir, CLOCK_FILE), 'utf8'));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((s): s is ClockSample => !!s && Number.isFinite((s as ClockSample).wall) && Number.isFinite((s as ClockSample).mono));
  } catch { return null; }
}

/** Monotonic milliseconds that do not advance while the Mac sleeps (mach_absolute_time / CLOCK_MONOTONIC). */
export const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** Append one sample, keeping the newest 400. Never throws; the record is best effort. */
export function recordClockSample(runsDir: string, wall: number, mono: number = monotonicMs()): void {
  try {
    const next = [...(readClockSamples(runsDir) ?? []), { wall, mono }].slice(-MAX_SAMPLES);
    const path = join(runsDir, CLOCK_FILE);
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch { /* best effort */ }
}

// ── readers ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReadGapsOptions {
  runsDir: string;
  now?: number;
  sinceMs?: number;
  minMinutes?: number;
  read?: (path: string) => Promise<string | null>;
  samples?: ClockSample[] | null;
  claudeLeftPct?: number | null;
}

export async function readFleetGaps(opts: ReadGapsOptions): Promise<FleetGapsReport> {
  const now = opts.now ?? Date.now();
  const since = now - (opts.sinceMs ?? 24 * 3_600_000);
  const read = opts.read ?? (async (path: string) => { try { return await readFile(path, 'utf8'); } catch { return null; } });
  let ticks: Tick[] | null = null;
  for (const path of dispatchEventsCandidates(opts.runsDir)) {
    const text = await read(path);
    if (text !== null) { ticks = parseTicks(text, now); break; }
  }
  const ledger = await read(join(opts.runsDir, 'metrics', 'jobs.jsonl'));
  const launches = ledger === null ? null : ledgerRows(ledger, now, Math.ceil((now - since) / 3_600_000) + 1, true).rows
    .filter(r => (r.row.event ?? null) === 'launch').map(r => r.at);
  let claudeLeftPct = opts.claudeLeftPct;
  if (claudeLeftPct === undefined) {
    claudeLeftPct = await import('../../cli/fleet-resources.js')
      .then(m => m.readFleetResourcesView(async p => (await read(p)) ?? Promise.reject(new Error('missing')), opts.runsDir, new Date(now)))
      .then(v => { const used = v.lanes.find(l => l.lane === 'claude')?.usedFrac; return typeof used === 'number' ? Math.round((1 - used) * 100) : null; })
      .catch(() => null);
  }
  const samples = opts.samples === undefined ? readClockSamples(opts.runsDir) : opts.samples;
  return buildFleetGaps({ ticks, launches, samples, now, since, minMinutes: opts.minMinutes, claudeLeftPct });
}
