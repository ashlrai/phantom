/**
 * The one thing holding the fleet back, for the first line of the hourly digest.
 *
 * Five things can cost launches: the Mac asleep (a dispatcher tick gap over 30 minutes), the host load gate,
 * a lane with free slots and nothing queued, a lane at its usage cap, and free disk under the freeze line.
 * Each is measured as launches lost in the last hour (free slots on the ticks it affected); the biggest wins and
 * a fixed order breaks ties. A source that cannot be read is named in `unknown`, never counted as zero.
 * `buildBlocker` is pure; `readBlocker` reads the same files the digest and `phm fleet gaps` already read.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diskBurn, readDiskSampleRows, readFreezeLine, type DiskBurn } from './host-disk.js';
import { DIGEST_GAP_MINUTES, etClock, readFleetGaps, readTicks, span, type FleetGap, type Tick } from './sleep-gaps.js';

export const DIGEST_BLOCKER_SCHEMA = 'digest.blocker.v1';
/** Highest priority first; decides a tie in launches lost. */
export const BLOCKER_TIE_ORDER = ['asleep', 'disk_low', 'host_load', 'pool_drained', 'queue_empty'] as const;
export type BlockerKind = (typeof BLOCKER_TIE_ORDER)[number] | 'none';

export interface DigestBlocker {
  kind: BlockerKind;
  /** One plain sentence, the digest's first line. */
  sentence: string;
  /** The figure the sentence leads with: minutes asleep, load, free slots, percent used or free GB; null for none or unknown. */
  number: number | null;
  as_of: string;
  /** Estimated launches lost in the last hour; null for none. */
  lost_launches: number | null;
  /** Sources that could not be read, so the pick may be missing a cause. */
  unknown: string[];
}

export interface BlockerLane { lane: string; running: number; target: number; held: boolean }
export interface BlockerResourceLane { lane: string; target: number | null; usedFrac: number | null; resetAt: string | null }
export interface BlockerAdmission { load1: number | null; loadMax: number | null }

export interface BlockerInput {
  nowMs: number;
  /** PLANNER_TICK lines; null when the dispatch log could not be read. */
  ticks: readonly Tick[] | null;
  /** Gaps over 30 minutes from `phm fleet gaps`; null when unreadable. */
  gaps: readonly FleetGap[] | null;
  /** Lane counts the digest already reads; null when unreadable. */
  lanes: readonly BlockerLane[] | null;
  /** Usage readings from resources.json; null when unreadable. */
  resources: readonly BlockerResourceLane[] | null;
  admission: BlockerAdmission | null;
  disk: Pick<DiskBurn, 'freeGb' | 'status' | 'freezeBelowGb'> | null;
}

interface Candidate { kind: Exclude<BlockerKind, 'none'>; sentence: string; number: number | null; lost: number }

const HOUR = 3_600_000;
const MIN = 60_000;
/** How often the dispatcher ticks, for turning minutes of silence into missed ticks. */
const TICK_MINUTES = 5;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const round1 = (n: number): number => Math.round(n * 10) / 10;

function asleep(input: BlockerInput): Candidate | null {
  const from = input.nowMs - HOUR;
  const gap = (input.gaps ?? [])
    .filter(g => g.minutes > DIGEST_GAP_MINUTES && g.lostWork !== false && Date.parse(g.end) > from)
    .sort((a, b) => b.minutes - a.minutes)[0];
  if (!gap) return null;
  const start = Date.parse(gap.start), end = Date.parse(gap.end);
  const overlapMin = (Math.min(end, input.nowMs) - Math.max(start, from)) / MIN;
  const lost = Math.max(gap.freeSlots ?? 1, 1) * Math.max(1, Math.ceil(overlapMin / TICK_MINUTES));
  const when = `${span(gap.minutes)} (${etClock(start)} to ${etClock(end)})`;
  const tail = gap.lostWork === null ? ', and whether work waited is unknown.' : ', so nothing ran.';
  const lead = gap.cause === 'host-asleep' ? `The Mac was asleep for ${when}` : `The dispatcher did not tick for ${when}`;
  return { kind: 'asleep', sentence: `${lead}${tail}`, number: gap.minutes, lost };
}

function hostLoad(input: BlockerInput, recent: readonly Tick[]): Candidate | null {
  const held = recent.filter(t => t.run === false && t.reason !== null && /load/i.test(t.reason));
  if (held.length === 0) return null;
  const lost = held.reduce((n, t) => n + Math.max(t.free ?? 1, 1), 0);
  const { load1, loadMax } = input.admission ?? { load1: null, loadMax: null };
  const figures = load1 === null ? 'load is unknown' : `load is ${round1(load1)}${loadMax === null ? ', limit unknown' : ` against a limit of ${round1(loadMax)}`}`;
  return { kind: 'host_load', sentence: `Launches were held back by host load ${plural(held.length, 'time', 'times')} in the last hour; ${figures}.`,
    number: load1 === null ? null : round1(load1), lost };
}

function queueEmpty(input: BlockerInput, recent: readonly Tick[]): Candidate | null {
  const idle = recent.filter(t => t.ready === 0 && (t.free ?? 0) > 0);
  if (idle.length === 0) return null;
  const lost = idle.reduce((n, t) => n + (t.free ?? 0), 0);
  const free = idle[idle.length - 1]!.free ?? 0;
  const open = (input.lanes ?? []).filter(l => !l.held && l.target > l.running).sort((a, b) => (b.target - b.running) - (a.target - a.running))[0];
  const where = open ? `${open.lane} has ${plural(open.target - open.running, 'free slot', 'free slots')} and` : `${plural(free, 'slot is', 'slots are')} free and`;
  return { kind: 'queue_empty', sentence: `Nothing is queued: ${where} no work is waiting (${plural(idle.length, 'tick', 'ticks')} in the last hour saw an empty queue).`, number: free, lost };
}

function poolDrained(input: BlockerInput, ticksInHour: number): Candidate | null {
  const rows = (input.resources ?? []).filter(r => r.usedFrac !== null && r.usedFrac >= 1 && (r.target ?? 0) > 0).map(r => {
    const lane = input.lanes?.find(l => l.lane === r.lane);
    const free = lane ? Math.max(0, lane.target - lane.running) : r.target ?? 0;
    return { r, free, lost: free * Math.max(1, ticksInHour) };
  }).filter(x => x.lost > 0).sort((a, b) => b.lost - a.lost || a.r.lane.localeCompare(b.r.lane));
  const top = rows[0];
  if (!top) return null;
  const resetMs = top.r.resetAt === null ? NaN : Date.parse(top.r.resetAt);
  const reset = Number.isFinite(resetMs) ? `resets at ${etClock(resetMs)} ET` : 'its reset time is unknown';
  return { kind: 'pool_drained', sentence: `The ${top.r.lane} lane is at its usage cap, so its ${plural(top.free, 'free slot', 'free slots')} cannot launch; ${reset}.`,
    number: Math.round((top.r.usedFrac ?? 1) * 100), lost: top.lost };
}

function diskLow(input: BlockerInput, recent: readonly Tick[]): Candidate | null {
  const disk = input.disk;
  if (!disk || disk.status !== 'below-threshold' || disk.freeGb === null) return null;
  const lost = Math.max(1, recent.reduce((n, t) => n + Math.max(t.free ?? 1, 1), 0));
  return { kind: 'disk_low', sentence: `Free disk is ${disk.freeGb} GB, under the ${disk.freezeBelowGb} GB line where lanes freeze. Run \`phm host disk\`.`, number: disk.freeGb, lost };
}

/** Pure: the biggest cost in the last hour, or `none`. */
export function buildBlocker(input: BlockerInput): DigestBlocker {
  const recent = (input.ticks ?? []).filter(t => t.at >= input.nowMs - HOUR && t.at <= input.nowMs);
  const unknown = [
    ...(input.ticks === null ? ['dispatch ticks'] : []), ...(input.gaps === null ? ['tick gaps'] : []),
    ...(input.resources === null ? ['pool usage'] : []), ...(input.disk === null ? ['free disk'] : []),
    ...(input.admission === null ? ['host load'] : []),
  ];
  const candidates = [asleep(input), hostLoad(input, recent), queueEmpty(input, recent), poolDrained(input, recent.length), diskLow(input, recent)]
    .filter((c): c is Candidate => c !== null && c.lost > 0)
    .sort((a, b) => b.lost - a.lost || BLOCKER_TIE_ORDER.indexOf(a.kind) - BLOCKER_TIE_ORDER.indexOf(b.kind));
  const as_of = new Date(input.nowMs).toISOString();
  const top = candidates[0];
  if (top) return { kind: top.kind, sentence: top.sentence, number: top.number, as_of, lost_launches: top.lost, unknown };
  const sentence = unknown.length ? `No blocker found, but unknown: ${unknown.join(', ')}.` : 'Nothing is holding launches back.';
  return { kind: 'none', sentence, number: null, as_of, lost_launches: null, unknown };
}

const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** load1 and load_max from status.json's admission block, else queue/admission.json; null when neither has a load reading. */
async function readAdmission(runsDir: string): Promise<BlockerAdmission | null> {
  for (const [file, pick] of [['status.json', (j: Record<string, unknown>) => j.admission], ['admission.json', (j: Record<string, unknown>) => j]] as const) {
    try {
      const json = JSON.parse(await readFile(join(runsDir, 'queue', file), 'utf8')) as Record<string, unknown>;
      const a = pick(json);
      if (a === null || typeof a !== 'object') continue;
      const row = a as Record<string, unknown>;
      const load1 = finite(row.load1), loadMax = finite(row.load_max);
      if (load1 !== null || loadMax !== null) return { load1, loadMax };
    } catch { /* try the next file */ }
  }
  return null;
}

/** Read every source once and pick. Never throws: a failed reader becomes an `unknown` entry. */
export async function readBlocker(runsDir: string, nowMs: number, lanes: readonly BlockerLane[] | null = null): Promise<DigestBlocker> {
  const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => { try { return await read(); } catch { return null; } };
  const [ticks, gapReport, resources, admission, disk] = await Promise.all([
    attempt(() => readTicks(runsDir, nowMs)),
    attempt(() => readFleetGaps({ runsDir, now: nowMs, sinceMs: 6 * HOUR, minMinutes: DIGEST_GAP_MINUTES + 1, claudeLeftPct: null })),
    attempt(async () => {
      const view = await (await import('../../cli/fleet-resources.js')).readFleetResourcesView(p => readFile(p, 'utf8'), runsDir, new Date(nowMs));
      return view.resources === 'healthy' ? view.lanes : null;
    }),
    attempt(() => readAdmission(runsDir)),
    attempt(async () => {
      const rows = readDiskSampleRows(runsDir, nowMs);
      return rows.length ? diskBurn(rows, (await readFreezeLine(runsDir)).gb, nowMs) : null;
    }),
  ]);
  return buildBlocker({ nowMs, ticks, gaps: gapReport && gapReport.sources.ticks === 'read' ? gapReport.gaps : null, lanes, resources, admission, disk });
}
