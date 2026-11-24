/**
 * routes/verse/fleet-router/decision-timeline-model.ts: the recorded decisions the Router pane
 * read, laid out over time. The span runs from the oldest decision read to now and is cut into
 * equal columns; each seat gets a lane holding how many decisions chose it in each column. It
 * counts records and nothing else: a decision whose time cannot be read is counted as not drawn,
 * never placed, and the span never reaches back past the oldest decision read (the log is the
 * newest 200, so anything earlier is not known to be empty).
 */
import type { ShadowDecisionRecord } from '../../../../core/routing/budget-store.js';

export const TIMELINE_COLUMNS = 24;
/** A log read within its first minutes still gets columns wide enough to name. */
const MIN_COLUMN_MS = 60_000;

export interface TimelineColumn {
  startMs: number;
  endMs: number;
  total: number;
  /** Decisions here whose record says the work ran on another seat than the one chosen. */
  moved: number;
  /** Places in the list the timeline was built from, in that list's order (newest first). */
  records: number[];
}

export interface TimelineLane {
  /** null = the decisions where the router found no seat. */
  seatId: string | null;
  counts: number[];
  moved: number[];
}

export interface DecisionTimeline {
  startMs: number;
  endMs: number;
  columnMs: number;
  columns: TimelineColumn[];
  lanes: TimelineLane[];
  /** The tallest single cell of any lane: every lane is drawn against it, so lanes compare. */
  peak: number;
  /** The most decisions in one column, all seats together. */
  busiest: number;
  drawn: number;
  undated: number;
}

/** null when no decision carries a readable time: there is nothing to place. */
export function decisionTimeline(records: readonly ShadowDecisionRecord[], now: number): DecisionTimeline | null {
  const times = records.map(record => Date.parse(record.at));
  const dated = times.filter(Number.isFinite);
  if (dated.length === 0) return null;
  const endMs = Math.max(now, ...dated);
  const startMs = Math.min(...dated, endMs - MIN_COLUMN_MS * TIMELINE_COLUMNS);
  const columnMs = (endMs - startMs) / TIMELINE_COLUMNS;
  const columns: TimelineColumn[] = Array.from({ length: TIMELINE_COLUMNS }, (_, index) => ({
    startMs: startMs + index * columnMs, endMs: startMs + (index + 1) * columnMs, total: 0, moved: 0, records: [] }));
  const lanes = new Map<string | null, TimelineLane>();
  records.forEach((record, place) => {
    const at = times[place]!;
    if (!Number.isFinite(at)) return;
    const index = Math.min(TIMELINE_COLUMNS - 1, Math.max(0, Math.floor((at - startMs) / columnMs)));
    const seatId = record.decision?.seatId ?? null, ran = record.actual?.seatId ?? null;
    const moved = ran !== null && ran !== seatId;
    const lane = lanes.get(seatId) ?? { seatId, counts: Array<number>(TIMELINE_COLUMNS).fill(0), moved: Array<number>(TIMELINE_COLUMNS).fill(0) };
    lanes.set(seatId, lane);
    lane.counts[index]! += 1;
    columns[index]!.total += 1;
    columns[index]!.records.push(place);
    if (moved) { lane.moved[index]! += 1; columns[index]!.moved += 1; }
  });
  return {
    startMs, endMs, columnMs, columns, lanes: [...lanes.values()],
    peak: Math.max(...[...lanes.values()].flatMap(lane => lane.counts)),
    busiest: Math.max(...columns.map(column => column.total)),
    drawn: dated.length, undated: records.length - dated.length,
  };
}

/** A length of time in the largest unit that keeps it readable: "45 s", "12 min", "2.5 h", "3 days". */
export function spanWords(ms: number): string {
  const one = (value: number) => String(Math.round(value * 10) / 10);
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 48 * 3_600_000) return `${one(ms / 3_600_000)} h`;
  return `${one(ms / 86_400_000)} days`;
}

const decisions = (count: number): string => count === 1 ? '1 decision' : `${count} decisions`;

/** What the whole chart shows, in one sentence. */
export function timelineWords(timeline: DecisionTimeline): string {
  const undated = timeline.undated === 0 ? '' : ` ${timeline.undated} with no readable time ${timeline.undated === 1 ? 'is' : 'are'} not drawn.`;
  return `${decisions(timeline.drawn)} over ${spanWords(timeline.endMs - timeline.startMs)}, ${spanWords(timeline.columnMs)} a column; the busiest column holds ${timeline.busiest}.${undated}`;
}

/** One column in words: its span, its count, the seats chosen in it (most first) and how many ran elsewhere. */
export function columnWords(timeline: DecisionTimeline, index: number, label: (seatId: string | null) => string, clock: (ms: number) => string): string {
  const column = timeline.columns[index];
  if (!column) return '';
  const span = `${clock(column.startMs)} to ${clock(column.endMs)}`;
  if (column.total === 0) return `${span}: no decisions.`;
  const seats = timeline.lanes.filter(lane => lane.counts[index]! > 0).sort((a, b) => b.counts[index]! - a.counts[index]!)
    .map(lane => `${label(lane.seatId)} ${lane.counts[index]}`).join(', ');
  return `${span}: ${decisions(column.total)}. ${seats}.${column.moved > 0 ? ` ${column.moved} ran on another seat.` : ''}`;
}

/** Where an arrow, Home or End moves the column being read; null for any other key. With none read yet, Left starts at the newest column and Right at the oldest. */
export function stepColumn(key: string, from: number | null, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowLeft') return from === null ? count - 1 : Math.max(0, from - 1);
  if (key === 'ArrowRight') return from === null ? 0 : Math.min(count - 1, from + 1);
  return null;
}
