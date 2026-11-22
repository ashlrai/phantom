/** Read-only reconstruction of recorded lane controller moves and their evidence.
 * The highest level observed in the window is not a configured target.
 * Current conditions and recovery remain unknown without positive evidence.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDispatchEvents, type DispatchEvent } from '../fabric/dispatch-events.js';
import { readJobsTail } from './report-ledger.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { scrubSecrets } from '../util/scrub.js';

export const LANE_ADAPT_SCHEMA = 'lanes.adapt.v1';
/** Memory counts as healthy again at this free percent (the controller's own "ok" zone starts at 25). */
export const MEM_OK_FREE_PCT = 25;
/** A cut lane is flagged once its recorded healthy evidence must span this long. */
export const HEALTHY_FLAG_MINUTES = 10;
const MINUTE = 60_000;

export type AdaptCause = 'memory' | 'swap' | 'load' | 'disk' | 'procs' | 'fork' | 'rate_limit' | 'other';

export interface AdaptCut {
  at: string;
  from: number;
  to: number;
  /** The controller's reason as written, e.g. `backoff:memguard`. */
  reason: string | null;
  causes: AdaptCause[];
  /** mem_why said a PAUSE file was present. */
  pause_file: boolean;
  signals: { mem_free_pct: number | null; swap_growth_gb: number | null; load1: number | null };
  /** One plain sentence: what happened and what the controller saw. */
  why: string;
}

export interface LaneCauseNow {
  /** True/false when the cause can be read now; null = unknown. */
  present: boolean | null;
  detail: string;
}

export interface LaneAdaptRow {
  lane: string;
  /** Current target, floor and ceiling from the dispatcher status; null when not published. */
  target: number | null;
  floor: number | null;
  ceiling: number | null;
  /** The level the controller last set in the window, or null when it did not move this lane. */
  adapted_level: number | null;
  /** Highest level seen in the window: what "below target" is measured against. */
  normal_level: number | null;
  still_cut: boolean;
  last_cut: AdaptCut | null;
  moves: Array<{ at: string; from: number; to: number; reason: string | null }>;
  minutes_below_target: number;
  empty_signals: { count: number | null; last_at: string | null };
  cause_now: LaneCauseNow | null;
  /** First healthy reading after the last cut, or null when unknown. */
  cause_cleared_by: string | null;
  backed_off_while_healthy: boolean;
  line: string;
}

export interface LaneAdaptReport {
  schema: typeof LANE_ADAPT_SCHEMA;
  generated_at: string;
  since: string;
  window_minutes: number;
  source: 'present' | 'missing' | 'unreadable';
  truncated: number;
  malformed: number;
  memory: { free_pct: number | null; paused: boolean | null };
  lanes: LaneAdaptRow[];
  flagged: string[];
}

interface FieldMap { [key: string]: string }

/** Split `a=1 b=two words c=3` into keys and values; a value runs to the next key. */
function fieldsOf(text: string): FieldMap {
  const out: FieldMap = {};
  const marks = [...text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)];
  marks.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : text.length;
    out[m[1]!] = text.slice(start, end).trim();
  });
  return out;
}
const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const m = /^-?\d+(?:\.\d+)?/.exec(v.trim());
  return m && Number.isFinite(Number(m[0])) ? Number(m[0]) : null;
};
const clean = (s: string, max = 120): string => scrubSecrets(s).replace(/(?:~\/|\/)[^\s]*/g, '[path]').replace(/\p{Cc}/gu, ' ').slice(0, max);
const hhmm = (iso: string): string => `${iso.slice(11, 16)}Z`;

function causesOf(reason: string | null, fields: FieldMap, pause: boolean): AdaptCause[] {
  const out = new Set<AdaptCause>();
  const body = (reason ?? '').replace(/^backoff:?/, '');
  for (const part of body.split(/[,+|]/).map(s => s.trim().toLowerCase()).filter(Boolean)) {
    if (/^mem/.test(part)) out.add('memory');
    else if (/^swap/.test(part)) out.add('swap');
    else if (/^(load|cpu)/.test(part)) out.add('load');
    else if (/^disk/.test(part)) out.add('disk');
    else if (/^proc/.test(part)) out.add('procs');
    else if (/^fork/.test(part)) out.add('fork');
    else if (/^rate/.test(part)) out.add('rate_limit');
    else out.add('other');
  }
  if (pause || fields.mem_why !== undefined) out.add('memory');
  return [...out];
}

function whyOf(cut: Omit<AdaptCut, 'why'>, memWhy: string | undefined): string {
  const bits: string[] = [];
  if (cut.pause_file) bits.push('the PAUSE file was present');
  else if (memWhy) bits.push(`memory check said "${clean(memWhy)}"`);
  if (cut.signals.mem_free_pct !== null) bits.push(`${cut.signals.mem_free_pct}% memory free`);
  else if (cut.causes.includes('memory') && !cut.pause_file && !memWhy) bits.push('the memory guard tripped (no reading recorded)');
  if (cut.signals.swap_growth_gb !== null) bits.push(`swap grew ${cut.signals.swap_growth_gb} GB`);
  else if (cut.causes.includes('swap')) bits.push('swap grew too fast (no size recorded)');
  if (cut.signals.load1 !== null) bits.push(`load ${cut.signals.load1}`);
  for (const c of cut.causes) {
    if (c === 'disk') bits.push('free disk was low');
    if (c === 'procs') bits.push('too many processes');
    if (c === 'fork') bits.push('a process could not start');
    if (c === 'rate_limit') bits.push('the provider rate-limited');
  }
  if (!bits.length) bits.push(cut.reason ? `reason: ${clean(cut.reason, 60)}` : 'no reason recorded');
  return `cut ${cut.from} to ${cut.to} slots at ${hhmm(cut.at)}: ${bits.join('; ')}`;
}

interface Move { at: number; iso: string; from: number; to: number; reason: string | null; cut: AdaptCut | null }

/** One ADAPT payload (`claude 8->2 reason=... `) to a move; null when it is not that shape. */
export function parseAdaptEvent(event: DispatchEvent): { lane: string; move: Move } | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+(\d+)\s*->\s*(\d+)\b\s*(.*)$/.exec(event.message);
  if (event.kind !== 'ADAPT' || !m || !Number.isFinite(Date.parse(event.at))) return null;
  const from = Number(m[2]); const to = Number(m[3]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
  const fields = fieldsOf(m[4] ?? '');
  const reason = fields.reason ? clean(fields.reason, 80) : null;
  const memWhy = fields.mem_why;
  const pause = memWhy !== undefined && /\bPAUSE\b/i.test(memWhy);
  const base = {
    at: event.at, from, to, reason, causes: causesOf(reason, fields, pause), pause_file: pause,
    signals: {
      mem_free_pct: num(fields.mem_free_pct ?? fields.mem_free ?? fields.free),
      swap_growth_gb: num(fields.swap_growth_gb ?? fields.swap_growth),
      load1: num(fields.load1 ?? fields.load),
    },
  };
  const cut = to < from ? { ...base, why: whyOf(base, memWhy) } : null;
  return { lane: m[1]!, move: { at: Date.parse(event.at), iso: event.at, from, to, reason, cut } };
}

export interface HealthySample { at: number; memFreePct: number | null }

/** Launch and pool rows in jobs.jsonl carry the free-memory reading taken when dispatchd was not paused. */
export function healthySamples(text: string | null): HealthySample[] {
  if (!text) return [];
  const out: HealthySample[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"launch"') && !line.includes('"pool"')) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(at) || (row.event !== 'launch' && row.event !== 'pool')) continue;
      out.push({ at, memFreePct: typeof row.mem_free_pct === 'number' ? row.mem_free_pct : null });
    } catch { /* skip a torn row */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface BuildLaneAdaptInput {
  events: DispatchEvent[];
  lanes: Array<{ lane: string; target: number; floor: number | null; ceiling: number | null }>;
  memFreePct: number | null;
  paused: boolean | null;
  samples?: HealthySample[];
  nowMs: number;
  sinceMs: number;
  source?: 'present' | 'missing' | 'unreadable';
  truncated?: number;
  malformed?: number;
}

function causeNow(cut: AdaptCut, mem: number | null, paused: boolean | null): LaneCauseNow {
  const memoryCause = cut.causes.includes('memory') || cut.pause_file;
  if (!memoryCause || cut.causes.some(c => c !== 'memory')) {
    return { present: null, detail: `unknown (${cut.causes.join(', ') || 'cause'} has no current reading here)` };
  }
  const low = mem !== null && mem < MEM_OK_FREE_PCT;
  const detail = `${mem === null ? 'free memory unknown' : `${mem}% memory free`}; ${paused === null ? 'pause state unknown' : paused ? 'paused' : 'not paused'}`;
  if (paused === true || low) return { present: true, detail };
  if (mem !== null && paused === false) return { present: false, detail };
  return { present: null, detail: `unknown (${detail})` };
}

/** The first healthy reading after the cut that stays healthy to the end, or null. */
function clearedBy(cut: AdaptCut, samples: HealthySample[], needMemory: boolean): number | null {
  let since: number | null = null;
  for (const s of samples.filter(x => x.at > Date.parse(cut.at))) {
    if (needMemory && s.memFreePct === null) { since = null; continue; }
    if (needMemory && s.memFreePct! < MEM_OK_FREE_PCT) since = null;
    else since ??= s.at;
  }
  return since;
}

export function buildLaneAdapt(input: BuildLaneAdaptInput): LaneAdaptReport {
  const { nowMs, sinceMs } = input;
  const moves = new Map<string, Move[]>();
  const empties = new Map<string, { count: number; last: number }>();
  for (const e of input.events) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || at < sinceMs || at > nowMs) continue;
    if (e.kind === 'ADAPT') {
      const parsed = parseAdaptEvent(e);
      if (parsed) moves.set(parsed.lane, [...(moves.get(parsed.lane) ?? []), parsed.move]);
    } else if (e.kind === 'EMPTY_SIGNAL') {
      const lane = /^([A-Za-z0-9][A-Za-z0-9._-]*)\b/.exec(e.message)?.[1];
      if (lane) { const cur = empties.get(lane) ?? { count: 0, last: 0 }; empties.set(lane, { count: cur.count + 1, last: Math.max(cur.last, at) }); }
    }
  }
  const names = [...new Set([...input.lanes.map(l => l.lane), ...moves.keys(), ...empties.keys()])].sort();
  const samples = input.samples ?? [];
  const rows: LaneAdaptRow[] = names.map(lane => {
    const known = input.lanes.find(l => l.lane === lane);
    const list = (moves.get(lane) ?? []).sort((a, b) => a.at - b.at);
    const empty = empties.get(lane);
    const base = {
      lane, target: known?.target ?? null, floor: known?.floor ?? null, ceiling: known?.ceiling ?? null,
      moves: list.map(m => ({ at: m.iso, from: m.from, to: m.to, reason: m.reason })),
      empty_signals: { count: input.source && input.source !== 'present' ? null : empty?.count ?? 0, last_at: empty ? new Date(empty.last).toISOString() : null },
    };
    if (!list.length) {
      return { ...base, adapted_level: null, normal_level: null, still_cut: false, last_cut: null, minutes_below_target: 0, cause_now: null,
        cause_cleared_by: null, backed_off_while_healthy: false,
        line: `${lane}: ${known ? `target ${known.target}${known.floor !== null || known.ceiling !== null ? ` (floor ${known.floor ?? 'unknown'}, ceiling ${known.ceiling ?? 'unknown'})` : ''}` : 'target unknown'}; the controller did not move it in this window` };
    }
    const normal = Math.max(...list.flatMap(m => [m.from, m.to]));
    let level = list[0]!.from; let cursor = sinceMs; let below = 0;
    for (const m of list) { if (level < normal) below += m.at - cursor; level = m.to; cursor = m.at; }
    if (level < normal) below += nowMs - cursor;
    const lastCut = [...list].reverse().find(m => m.cut)?.cut ?? null;
    const stillCut = level < normal && lastCut !== null;
    const now = lastCut && stillCut ? causeNow(lastCut, input.memFreePct, input.paused) : null;
    const memoryCause = !!lastCut && (lastCut.causes.includes('memory') || lastCut.pause_file);
    const cleared = lastCut && now?.present === false && memoryCause
      ? clearedBy(lastCut, samples.filter(s => s.at <= nowMs), true) : null;
    const flagged = cleared !== null && nowMs - cleared > HEALTHY_FLAG_MINUTES * MINUTE;
    const minutes = Math.round(below / MINUTE);
    const ago = lastCut ? Math.max(0, Math.round((nowMs - Date.parse(lastCut.at)) / MINUTE)) : 0;
    const head = `${lane}: at ${level}; highest observed ${normal}`;
    let line: string;
    if (!stillCut) line = `${head}; at the highest observed level after ${minutes} min below target in this window`;
    else {
      const tail = flagged ? `; ${now!.detail}, healthy for over ${HEALTHY_FLAG_MINUTES} min, still cut (backed_off_while_healthy)`
        : now!.present === true ? `; cause still present (${now!.detail})`
        : now!.present === false ? `; cause is gone now (${now!.detail}); when it cleared is unknown`
        : `; cause now: ${now!.detail}`;
      line = `${head} for ${minutes} min; last ${lastCut!.why} (${ago} min ago)${tail}`;
    }
    return { ...base, adapted_level: level, normal_level: normal, still_cut: stillCut, last_cut: lastCut, minutes_below_target: minutes,
      cause_now: now, cause_cleared_by: cleared === null ? null : new Date(cleared).toISOString(), backed_off_while_healthy: flagged, line };
  });
  return {
    schema: LANE_ADAPT_SCHEMA, generated_at: new Date(nowMs).toISOString(), since: new Date(sinceMs).toISOString(),
    window_minutes: Math.round((nowMs - sinceMs) / MINUTE), source: input.source ?? 'present', truncated: input.truncated ?? 0, malformed: input.malformed ?? 0,
    memory: { free_pct: input.memFreePct, paused: input.paused }, lanes: rows,
    flagged: rows.filter(r => r.backed_off_while_healthy).map(r => r.lane),
  };
}

export function formatLaneAdaptText(report: LaneAdaptReport): string {
  const out = [`Lane slots, last ${report.window_minutes >= 120 ? `${Math.round(report.window_minutes / 60)} h` : `${report.window_minutes} min`} (memory ${report.memory.free_pct === null ? 'free unknown' : `${report.memory.free_pct}% free`}, ${report.memory.paused === null ? 'pause state unknown' : report.memory.paused ? 'paused' : 'not paused'})`];
  if (report.source !== 'present') out.push(`The dispatch event log is ${report.source}, so cuts are unknown.`);
  if (report.truncated || report.malformed) out.push(`Evidence incomplete: ${report.truncated} truncated, ${report.malformed} malformed.`);
  for (const row of report.lanes) {
    out.push(...row.moves.map(m => `${row.lane}: ${m.from}->${m.to} at ${m.at}; reason ${m.reason ?? "unknown"}`));
    out.push(row.line + (row.empty_signals.count ? `; ${row.empty_signals.count} missing-reading notice${row.empty_signals.count === 1 ? '' : 's'}` : ''));
  }
  if (report.flagged.length) out.push(`Cut while healthy: ${report.flagged.join(', ')}. The cause is gone; slots are ramping back slowly.`);
  return out.join('\n');
}

/** The digest line for lanes cut while healthy, or null when none. */
export function laneAdaptDigestLine(report: LaneAdaptReport): string | null {
  const rows = report.lanes.filter(r => r.backed_off_while_healthy);
  const first = rows[0];
  if (!first) return null;
  return `adapt: ${first.lane} is at ${first.adapted_level} of ${first.normal_level} slots but the cause (${first.last_cut!.causes[0] ?? 'unknown'}) cleared over ${HEALTHY_FLAG_MINUTES} min ago${rows.length > 1 ? ` (+${rows.length - 1} more lane${rows.length > 2 ? 's' : ''})` : ''}`;
}

export interface ReadLaneAdaptOptions {
  runsDir?: string; now?: () => number; sinceMs?: number;
  readers?: { events: typeof readDispatchEvents; state: typeof readFleetRunsDirState; jobs: typeof readJobsTail };
}

/** Reads the event log, dispatcher status and launch readings, then builds the report. Never throws. */
export async function readLaneAdapt(options: ReadLaneAdaptOptions = {}): Promise<LaneAdaptReport> {
  const nowMs = (options.now ?? Date.now)();
  const sinceMs = options.sinceMs ?? nowMs - 6 * 3_600_000;
  const runs = options.runsDir === undefined ? {} : { runsDir: options.runsDir };
  const readers = options.readers ?? { events: readDispatchEvents, state: readFleetRunsDirState, jobs: readJobsTail };
  const [log, state, jobs] = await Promise.all([
    readers.events({ ...runs, since: new Date(sinceMs).toISOString() }).catch(() => null),
    readers.state({ ...runs, now: () => nowMs }).catch(() => null),
    readers.jobs(join(options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'metrics', 'jobs.jsonl')).catch(() => ({ text: null })),
  ]);
  return buildLaneAdapt({
    events: log?.events ?? [], lanes: state?.lanes ?? [], memFreePct: state?.memFreePct ?? null, paused: state?.paused ?? null,
    samples: healthySamples(jobs.text), nowMs, sinceMs, source: log?.source ?? 'unreadable', truncated: log?.truncated ?? 0, malformed: log?.malformedLines ?? 0,
  });
}
