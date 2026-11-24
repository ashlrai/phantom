/**
 * routes/verse/fleet-router/seat-pool-model.ts: the route table turned on its side. The table
 * answers "which seat takes this kind of work"; this fold answers "what does the router do with
 * this seat": for every seat the router or the budget reading names, where it stands for each of
 * the kinds of work asked about (first choice, a later try, held back, not named, or no answer),
 * beside the usage windows and the fleet standing the budget reading reports for it.
 *
 * Counts cells of the table already read and copies readings; it asks nothing and infers nothing.
 * A window with no reading is left out rather than drawn at zero.
 */
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { RoutingDifficulty, RoutingTask } from '../../../../core/routing/types.js';
import { heldBackText, joinSentences } from '../fleet/why-seat-model.js';
import { usedPercentText } from '../percent-text.js';
import { ROUTER_DIFFICULTIES, ROUTER_TASKS, routeAt, seatBrand, type BudgetRoute } from './router-model.js';

/** `unnamed` = the router answered for that kind of work and did not mention this seat; `unknown` = it gave no answer. */
export type SeatStanding = 'first' | 'later' | 'held' | 'unnamed' | 'unknown';

export interface SeatCell {
  task: RoutingTask;
  difficulty: RoutingDifficulty;
  standing: SeatStanding;
  /** 1-based place in the try order; null unless the seat is in it. */
  rank: number | null;
  /** The router's reason for holding the seat back from this kind of work; null otherwise. */
  reason: string | null;
}

export interface PoolWindow {
  name: 'session' | 'weekly';
  usedPercent: number;
  /** The window fleet work is measured against. Only its reset is reported. */
  binding: boolean;
  resetAt: string | null;
}

export interface PoolSeat {
  seatId: string;
  label: string;
  brand: string;
  /** Local seats have no provider window. */
  free: boolean;
  /** One cell per kind of work, in the route table's order: tasks down, difficulties across. */
  cells: SeatCell[];
  first: number;
  later: number;
  held: number;
  /** The windows the budget reading holds a percent for; empty = no reading. */
  windows: PoolWindow[];
  /** What the budget reading says about fleet work on this seat; null when it names no such seat. */
  fleet: { open: boolean; headroomPercent: number | null; window: 'session' | 'weekly' | null; reasons: string } | null;
}

export interface SeatPool {
  seats: PoolSeat[];
  /** Kinds of work the router answered for; the counts on each seat are out of this. */
  answered: number;
  taking: number;
  standby: number;
  out: number;
}

const ORDINALS = ['', '1st', '2nd', '3rd'];
const ordinal = (rank: number): string => ORDINALS[rank] ?? `${rank}th`;
const lower = (text: string): string => text.toLowerCase();

/** Every seat the budget reading or any answered cell names, the ones carrying the most work first. */
export function seatPool(routes: readonly BudgetRoute[], view: BudgetView | null): SeatPool {
  const ids = new Set<string>(view?.seatInfo.map(seat => seat.seatId) ?? []);
  for (const { decision } of routes) {
    for (const seatId of decision.candidates) ids.add(seatId);
    for (const exclusion of decision.exclusions) ids.add(exclusion.seatId);
  }
  const seats = [...ids].map((seatId): PoolSeat => {
    const info = view?.seatInfo.find(seat => seat.seatId === seatId);
    const headroom = view?.headroom.find(seat => seat.seatId === seatId);
    const cells = ROUTER_TASKS.flatMap(task => ROUTER_DIFFICULTIES.map((difficulty): SeatCell => {
      const kind = { task: task.value, difficulty: difficulty.value };
      const decision = routeAt(routes, kind.task, kind.difficulty);
      if (!decision) return { ...kind, standing: 'unknown', rank: null, reason: null };
      const place = decision.candidates.indexOf(seatId);
      if (place >= 0) return { ...kind, standing: decision.seatId === seatId ? 'first' : 'later', rank: place + 1, reason: null };
      const exclusion = decision.exclusions.find(x => x.seatId === seatId);
      return exclusion ? { ...kind, standing: 'held', rank: null, reason: heldBackText(exclusion) || null } : { ...kind, standing: 'unnamed', rank: null, reason: null };
    }));
    const count = (standing: SeatStanding) => cells.filter(cell => cell.standing === standing).length;
    const binding = headroom?.bindingWindow ?? null;
    const windows = (['session', 'weekly'] as const).flatMap((name): PoolWindow[] => {
      const usedPercent = name === 'session' ? headroom?.sessionUsedPercent : headroom?.weeklyUsedPercent;
      return typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? [{ name, usedPercent, binding: binding === name, resetAt: binding === name ? headroom?.resetAt ?? null : null }] : [];
    });
    return {
      seatId, label: info?.label ?? seatId, brand: seatBrand(view, seatId), free: info?.free ?? false, cells, windows,
      first: count('first'), later: count('later'), held: count('held'),
      fleet: headroom ? { open: headroom.eligibleForAutonomy === true, window: binding, reasons: joinSentences(Array.isArray(headroom.reasons) ? headroom.reasons : []),
        headroomPercent: typeof headroom.autonomyHeadroomPercent === 'number' && Number.isFinite(headroom.autonomyHeadroomPercent) ? headroom.autonomyHeadroomPercent : null } : null,
    };
  }).sort((a, b) => b.first - a.first || b.later - a.later || a.held - b.held || a.label.localeCompare(b.label));
  return {
    seats, answered: routes.length,
    taking: seats.filter(seat => seat.first > 0).length,
    standby: seats.filter(seat => seat.first === 0 && seat.later > 0).length,
    out: seats.filter(seat => seat.first === 0 && seat.later === 0).length,
  };
}

/** "3 seats: 2 take work first, 1 only as a later try." Says only the groups that hold a seat. */
export function poolWords(pool: SeatPool): string {
  if (pool.seats.length === 0) return 'The router and the budget reading name no seat.';
  const groups = [
    pool.taking > 0 ? `${pool.taking} ${pool.taking === 1 ? 'takes' : 'take'} work first` : '',
    pool.standby > 0 ? `${pool.standby} only as a later try` : '',
    pool.out > 0 ? `${pool.out} in no try order` : '',
  ].filter(Boolean);
  return `${pool.seats.length} ${pool.seats.length === 1 ? 'seat' : 'seats'}: ${groups.join(', ')}.`;
}

/** Where the seat stands across the kinds of work answered, as one line. */
export function standingWords(seat: PoolSeat, answered: number): string {
  if (answered === 0) return 'Standing unknown';
  const parts = [
    seat.first > 0 ? `First for ${seat.first} of ${answered}` : '',
    seat.later > 0 ? `a later try for ${seat.later}` : '',
    seat.held > 0 ? `held back from ${seat.held}` : '',
  ].filter(Boolean).join(', ');
  if (parts === '') return 'Not named for any kind of work';
  return parts.charAt(0).toUpperCase() + parts.slice(1);
}

const kindWords = (cell: SeatCell): string =>
  `${lower(ROUTER_TASKS.find(task => task.value === cell.task)!.label)} ${lower(ROUTER_DIFFICULTIES.find(difficulty => difficulty.value === cell.difficulty)!.label)}`;

/** One cell said in full: the seat, the kind of work, and where the seat stands for it. */
export function cellWords(seat: PoolSeat, cell: SeatCell): string {
  const standing = cell.standing === 'first' ? 'first choice'
    : cell.standing === 'later' ? `tried ${ordinal(cell.rank ?? 0)}`
      : cell.standing === 'held' ? `held back${cell.reason ? `. ${cell.reason}` : ''}`
        : cell.standing === 'unnamed' ? 'not named by the router' : 'no answer from the router';
  return `${seat.label}, ${kindWords(cell)}: ${standing}`;
}

/** A window in words: "Weekly: 23% used". */
export const windowWords = (window: PoolWindow): string => `${window.name === 'session' ? 'Session' : 'Weekly'}: ${usedPercentText(window.usedPercent)} used`;

/** What the budget reading says about fleet work on the seat. Unknown stays unknown. */
export function fleetWords(seat: PoolSeat): string {
  if (!seat.fleet) return 'Fleet standing unknown: the budget reading does not name this seat.';
  if (!seat.fleet.open) return `Closed to fleet work${seat.fleet.reasons ? `. ${seat.fleet.reasons}` : ': the budget reading gives no reason.'}`;
  if (seat.fleet.headroomPercent === null || seat.fleet.window === null) return 'Open to fleet work.';
  return `Open to fleet work, which may use ${usedPercentText(seat.fleet.headroomPercent)} more of the ${seat.fleet.window} window.`;
}
