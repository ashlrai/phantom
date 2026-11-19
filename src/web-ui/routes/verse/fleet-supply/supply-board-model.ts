/**
 * routes/verse/fleet-supply/supply-board-model.ts — the Supply board's shapes: one card per lane (the slots opening in
 * the next window set against the jobs waiting for them), the fleet strip and the totals line. Pure; every figure is
 * counted from the rows laneSupply() built out of GET /api/verse/fleet/runs.
 *
 * When the drop folder could not be read, the pending-file count is unknown, not zero: the card then counts only the
 * queued jobs, says so, and states every shortfall as an upper bound ("up to N").
 */
import { HORIZON_SECONDS, totalShortfall, supplyHeadline, type LaneSupply } from './supply-model.js';

/** Above this many opening slots a lane draws one bar instead of a square per slot. */
export const MAX_MARKS = 32;

export type SupplyState = 'held' | 'short' | 'supplied' | 'quiet';
export type SlotMark = 'covered' | 'short';

export interface SupplyFact { label: string; value: string }

export interface SupplyCard extends LaneSupply {
  state: SupplyState;
  stateText: string;
  /** Pending files plus queued jobs; only the queued jobs when the files are unknown. */
  waiting: number;
  /** Opening slots that have a job waiting. */
  covered: number;
  /** Jobs waiting beyond the slots that open. */
  spare: number;
  /** One mark per opening slot, covered ones first. Null when nothing opens or the lane is too large to count by eye. */
  marks: SlotMark[] | null;
  /** Share of opening slots with a job waiting. Null when nothing opens. */
  coveredPct: number | null;
  picture: string;
  facts: SupplyFact[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const horizon = `${HORIZON_SECONDS / 60} min`;

export function supplyCard(source: LaneSupply, pendingKnown: boolean): SupplyCard {
  // Files that could not be counted are left out entirely, so a stale count never covers a slot.
  const row: LaneSupply = pendingKnown ? source
    : { ...source, pendingFiles: 0, shortfall: source.held ? 0 : Math.max(source.demand - source.queued, 0) };
  const waiting = row.pendingFiles + row.queued;
  const covered = Math.min(row.demand, waiting);
  const spare = Math.max(waiting - row.demand, 0);
  const bound = pendingKnown ? '' : 'up to ';
  const state: SupplyState = row.held ? 'held' : row.shortfall > 0 ? 'short' : row.demand === 0 ? 'quiet' : 'supplied';
  const stateText = state === 'held' ? 'Held, not counted'
    : state === 'short' ? `${bound}${row.shortfall} short`
    : state === 'quiet' ? 'No slots opening' : 'Supplied';
  const marks = row.demand > 0 && row.demand <= MAX_MARKS
    ? Array.from({ length: row.demand }, (_, i): SlotMark => (i < covered ? 'covered' : 'short')) : null;
  return {
    ...row, state, stateText, waiting, covered, spare, marks,
    coveredPct: row.demand > 0 ? (covered / row.demand) * 100 : null,
    picture: `${row.lane}: ${covered} of ${plural(row.demand, 'opening slot')} ${covered === 1 ? 'has' : 'have'} a job waiting${pendingKnown ? '' : ' (job files not counted)'}`,
    facts: [
      { label: 'Running / target', value: `${row.running}/${row.target}` },
      { label: 'Free now', value: String(row.freeNow) },
      { label: `Freeing ≤${HORIZON_SECONDS / 60} m`, value: String(row.freeingSoon) },
      { label: 'Waiting', value: pendingKnown ? String(waiting) : `${row.queued} queued, files unknown` },
      { label: 'Shortfall', value: row.held ? 'none while held' : `${row.shortfall > 0 ? bound : ''}${row.shortfall}` },
    ],
  };
}

/** The heading: the same words as before, except that an unread drop folder makes the count an upper bound. */
export function boardHeadline(cards: readonly SupplyCard[], pendingKnown: boolean): string {
  const total = totalShortfall(cards);
  if (pendingKnown || total === 0) return `${supplyHeadline(cards)}${total > 0 ? ` · Shortfall ${total} slots` : ''}`;
  return `Write up to ${total} more job files · Shortfall up to ${total} slots`;
}

/** The line under the heading: what opens, what waits for it, and how many lanes are left out because they are held. */
export function totalsLine(cards: readonly SupplyCard[], pendingKnown: boolean): string | null {
  if (cards.length === 0) return null;
  const open = cards.filter(card => !card.held);
  const held = cards.length - open.length;
  const opening = open.reduce((sum, card) => sum + card.demand, 0);
  const waiting = open.reduce((sum, card) => sum + card.waiting, 0);
  return [
    `${plural(opening, 'slot')} ${opening === 1 ? 'opens' : 'open'} within ${horizon}`,
    pendingKnown ? `${plural(waiting, 'job')} waiting` : `${waiting} queued, job files unknown`,
    held > 0 ? `${plural(held, 'lane')} held` : '',
  ].filter(Boolean).join(' · ');
}

export interface StripSegment { lane: string; weight: number; coveredPct: number; state: SupplyState }

/** Every lane's opening slots end to end, each segment as wide as its slots and filled by the jobs waiting for them. */
export function supplyStrip(cards: readonly SupplyCard[]): { segments: StripSegment[]; label: string } | null {
  const open = cards.filter(card => !card.held && card.demand > 0);
  if (open.length === 0) return null;
  const opening = open.reduce((sum, card) => sum + card.demand, 0);
  const covered = open.reduce((sum, card) => sum + card.covered, 0);
  return {
    segments: open.map(card => ({ lane: card.lane, weight: card.demand, coveredPct: card.coveredPct ?? 0, state: card.state })),
    label: `${covered} of ${plural(opening, 'opening slot')} ${covered === 1 ? 'has' : 'have'} a job waiting`,
  };
}

export interface WasteBar { usedPct: number; burnPct: number; unusedPct: number; label: string }

/** A weekly window at reset: used so far, what the current burn adds by then, and what is left unused. */
export function wasteBar(usedPct: number | null, unusedPct: number, burnKnown: boolean): WasteBar | null {
  if (usedPct === null || !Number.isFinite(usedPct)) return null;
  const used = Math.max(0, Math.min(100, usedPct));
  const unused = Math.max(0, Math.min(100 - used, unusedPct));
  const burn = 100 - used - unused;
  return {
    usedPct: used, burnPct: burn, unusedPct: unused,
    label: `${Math.round(used)}% used, ${burnKnown ? `${Math.round(burn)}% more by reset at the current burn` : 'burn unknown'}, ${Math.round(unused)}% unused`,
  };
}
