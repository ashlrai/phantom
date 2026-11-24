/**
 * leader-seat-swap.ts: which seat the leader can move to when its pool runs out.
 *
 * Builds on `leader.seat.v1` (leader-seat.ts) and the pace reader (pools-view.ts):
 * the current seat with its usage and "empty at", the other seats in order with a
 * plain state each, and the seat that would run the next pass. When the current
 * pool is at 98% or more, or the last two passes failed on a usage limit, it also
 * hands Security the one-line wrapper change (model and command only, never env
 * values or credentials). Read-only apart from `writeSeatSwapDraft`, which writes
 * that line to `<runs>/leader/drafts/`; the pinned wrapper is never touched.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { laneModelFamily } from './lane-models.js';
import { leaderSeatCommand, readLeaderSeat, seatModelName, type LeaderLaneSeat, type LeaderSeatFailure, type LeaderSeatReaders, type LeaderSeatReport } from './leader-seat.js';
import type { PoolRow, PoolsViewV1 } from './pools-view.js';

export const SEAT_SWAP_SCHEMA = 'leader.seat-swap.v1';
/** The current pool counts as spent at this share used. */
export const SEAT_SWAP_USED_PCT = 98;
/** This many usage-limit failures in a row also call for a move. */
export const SEAT_SWAP_LIMIT_FAILURES = 2;

export interface SeatSwapSeat {
  lane: string;
  /** "Claude", "personal Codex". */
  pool: string;
  model: string | null;
  modelName: string | null;
  usedPct: number | null;
  /** The state in plain words: "ok", "used up, back 3:30 PM". */
  state: string;
  /** True when the seat can take a pass right now. */
  usable: boolean;
  /** When a seat that cannot take a pass now can again (ISO); null when usable now or unknown. */
  backAt: string | null;
  line: string;
}
export interface SeatSwapView {
  schema: typeof SEAT_SWAP_SCHEMA;
  generatedAt: string;
  current: (SeatSwapSeat & { emptyAt: string | null }) | null;
  /** Every other seat: usable now first, then soonest back. */
  fallbacks: SeatSwapSeat[];
  /** The seat the leader moves to when the current one runs out. */
  next: SeatSwapSeat | null;
  /** The seat that would run the next pass. */
  runsNext: SeatSwapSeat | null;
  /** True when the current seat should be swapped now (98% used, or repeated usage-limit failures). */
  moveNeeded: boolean;
  moveWhy: string | null;
  /** The one-line wrapper change for Security; null when no move is needed or no seat is known. */
  proposal: { line: string; from: string | null; to: string; applyFrom: string | null } | null;
  /** The Leader card line. */
  line: string;
}
export interface SeatSwapInput { usageLimitFailures?: number; timeZone?: string }

/** "claude" is "Claude"; "codex-personal" is "personal Codex". */
export function seatPoolName(lane: string): string {
  const family = laneModelFamily(lane);
  const name = family[0]!.toUpperCase() + family.slice(1);
  const rest = lane.startsWith(`${family}-`) ? lane.slice(family.length + 1).replace(/[-_]+/g, ' ') : '';
  return rest ? `${rest} ${name}` : name;
}

/** "3:30 PM" today, "Thu 3 PM" on another day, in the given zone (local when omitted). */
export function seatClock(iso: string, now: number, timeZone?: string): string {
  const at = new Date(iso), zone = timeZone ? { timeZone } : {};
  const time = at.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', ...zone }).replace(':00', '').replace(/\s/g, ' ');
  const day = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', ...zone });
  return day(at) === day(new Date(now)) ? time : `${at.toLocaleString('en-US', { weekday: 'short', ...zone })} ${time}`;
}

const futureMs = (iso: string | null | undefined, now: number): number | null => {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) && ms > now ? ms : null;
};
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1).replace(/\.$/, '');

export function buildSeatSwap(report: LeaderSeatReport, pools: PoolsViewV1 | null, now: number, input: SeatSwapInput = {}): SeatSwapView {
  const clock = (iso: string) => seatClock(iso, now, input.timeZone);
  const row = (lane: string): PoolRow | undefined => pools?.pools.find(pool => pool.id === lane);
  const seatOf = (s: LeaderLaneSeat): SeatSwapSeat => {
    const pool = seatPoolName(s.lane);
    const used = s.headroomPct !== null ? 100 - s.headroomPct : row(s.lane)?.usedPct ?? null;
    const backMs = futureMs(s.resetAt, now);
    const spent = s.headroomPct === 0 || (used !== null && used >= 100);
    const state = s.eligible ? `ok${used === null ? '' : `, ${Math.round(used)}% used`}`
      : spent ? `used up${backMs ? `, back ${clock(s.resetAt!)}` : ''}` : lower(s.reason ?? 'not available');
    return { lane: s.lane, pool, model: s.model, modelName: s.model ? seatModelName(s.model) : null, usedPct: used, state,
      usable: s.eligible, backAt: !s.eligible && spent && backMs ? s.resetAt : null, line: `${pool}: ${state}` };
  };
  const all = [...(report.currentSeat ? [report.currentSeat] : []), ...report.fallbacks.filter(s => s.lane !== report.current.lane)];
  const byLane = new Map(all.map(s => [s.lane, s]));
  const resetOrder = (s: SeatSwapSeat) => futureMs(byLane.get(s.lane)?.resetAt, now) ?? Infinity;
  const others = report.fallbacks.map(seatOf).sort((a, b) => Number(b.usable) - Number(a.usable) || resetOrder(a) - resetOrder(b));
  const cur = report.currentSeat ? seatOf(report.currentSeat) : null;
  const emptyAt = report.current.lane ? row(report.current.lane)?.projectedEmptyAt ?? null : null;
  const currentView = cur && { ...cur, emptyAt };

  const usedPct = cur?.usedPct ?? report.current.used_pct ?? null;
  const limitHits = input.usageLimitFailures ?? 0;
  const moveWhy = usedPct !== null && usedPct >= SEAT_SWAP_USED_PCT ? `${cur?.pool ?? 'The current pool'} is ${Math.round(usedPct)}% used`
    : limitHits >= SEAT_SWAP_LIMIT_FAILURES ? `the last ${SEAT_SWAP_LIMIT_FAILURES} leader passes hit a usage limit` : null;
  const moveNeeded = moveWhy !== null;
  const currentUsable = !!cur && cur.usable && !moveNeeded;

  // The target: a seat usable now, else the one that comes back soonest.
  const backing = others.filter(s => s.backAt && s.model && byLane.get(s.lane)?.cli && byLane.get(s.lane)?.confirmed)
    .sort((a, b) => resetOrder(a) - resetOrder(b));
  const next = others.find(s => s.usable) ?? backing[0] ?? null;
  const runsNext = currentUsable ? cur : next?.usable ? next : null;
  const from = (s: SeatSwapSeat | null) => (s?.backAt ? ` from ${clock(s.backAt)}` : '');

  let proposal: SeatSwapView['proposal'] = null;
  const target = next && byLane.get(next.lane);
  if (moveNeeded && next && target?.cli && target.model) {
    try {
      const to = leaderSeatCommand({ cli: target.cli, model: target.model }, '-').argv.join(' ');
      const was = report.currentSeat?.cli && report.currentSeat.model ? leaderSeatCommand({ cli: report.currentSeat.cli, model: report.currentSeat.model }, '-').argv.join(' ') : null;
      proposal = { from: was, to, applyFrom: next.backAt,
        line: `Leader pass command${was ? `: ${was}  ->  ${to}` : ` becomes: ${to}`}${next.backAt ? ` (apply from ${clock(next.backAt)})` : ''}` };
    } catch { proposal = null; }
  }

  const earliest = [cur, ...others].filter((s): s is SeatSwapSeat => !!s && !s.usable && !!s.backAt)
    .sort((a, b) => resetOrder(a) - resetOrder(b))[0] ?? null;
  let line: string;
  if (!cur && !next) line = 'Leader seat unknown: no seat state is available.';
  else if (currentUsable) {
    const pace = emptyAt ? `${cur!.pool} empty about ${clock(emptyAt)}` : `${cur!.pool} ${cur!.usedPct === null ? 'usage unknown' : `${Math.round(cur!.usedPct)}% used`}`;
    line = `Leader runs on ${cur!.modelName ?? cur!.pool}; ${pace}; next seat: ${next ? `${next.pool}${from(next) || ' now'}` : 'none'}`;
  } else if (runsNext) line = `Leader should move to ${runsNext.pool} now: ${moveWhy ?? lower(cur?.state ?? 'its seat is not available')}.`;
  else if (earliest) line = `No seat until ${clock(earliest.backAt!)} (${earliest.pool}).`;
  else line = 'No seat available, and no reset time is known.';
  return { schema: SEAT_SWAP_SCHEMA, generatedAt: new Date(now).toISOString(), current: currentView, fallbacks: others, next, runsNext,
    moveNeeded, moveWhy, proposal, line };
}

export function seatSwapText(view: SeatSwapView): string {
  return [view.line,
    ...(view.current ? [`Now: ${view.current.line}${view.current.emptyAt ? `, empty about ${seatClock(view.current.emptyAt, Date.parse(view.generatedAt))}` : ''}`] : []),
    ...view.fallbacks.map((s, i) => `${i + 1}. ${s.line}`),
    ...(view.proposal ? ['', 'Wrapper change for Security:', view.proposal.line] : [])].join('\n');
}

/** The pace view from the resource ledger, the same read `planner-slate --propose` uses; null when it cannot be read. */
export async function readSeatPools(runsDir: string, now: number): Promise<PoolsViewV1 | null> {
  try {
    const [{ readResourceLedger }, { buildPoolsView }, { readUsageSamples }] = await Promise.all([
      import('./runs-resource-ledger.js'), import('./pools-view.js'), import('./usage-history.js')]);
    return buildPoolsView(await readResourceLedger({ runsDir, now: () => now }), now, await readUsageSamples({ runsDir, nowMs: now }));
  } catch { return null; }
}

export async function readSeatSwap(readers: Partial<LeaderSeatReaders> & { pools?: () => Promise<PoolsViewV1 | null>; runsDir?: string } = {}, input: SeatSwapInput = {}): Promise<SeatSwapView> {
  const now = (readers.now ?? Date.now)();
  const runsDir = readers.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const failuresRead = readers.failures ?? (async () => []);
  const [report, pools, failures] = await Promise.all([
    readLeaderSeat({ ...readers, now: () => now }), (readers.pools ?? (() => readSeatPools(runsDir, now)))(),
    failuresRead().catch((): LeaderSeatFailure[] => [])]);
  const lane = report.current.lane;
  const hits = new Set([...failures.filter(f => f.lane === lane && f.kind === 'rate-limit').map(f => f.at),
    ...(report.currentSeat?.rateLimitedAt ? [report.currentSeat.rateLimitedAt] : [])]);
  return buildSeatSwap(report, pools, now, { usageLimitFailures: hits.size, ...input });
}

/** Writes the one-line proposal for Security to `<runs>/leader/drafts/seat-swap.txt` (overwritten each time). Returns the path, or null when there is no proposal. */
export async function writeSeatSwapDraft(view: SeatSwapView, runsDir: string): Promise<string | null> {
  if (!view.proposal) return null;
  const dir = join(runsDir, 'leader', 'drafts'), file = join(dir, 'seat-swap.txt'), tmp = `${file}.${process.pid}.tmp`;
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, `${view.proposal.line}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return file;
}
