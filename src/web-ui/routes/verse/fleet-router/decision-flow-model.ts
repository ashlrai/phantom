/**
 * routes/verse/fleet-router/decision-flow-model.ts: the recorded decisions the Router pane read,
 * laid out as a flow from what was asked (the kind of work, its difficulty or who asked) to the
 * seat the router chose. Every node and band is a count of records and one scale turns counts
 * into pixels, so a band is as thick at the seat as it is at the request. A record that does not
 * say what was asked is counted under "Not recorded", never dropped and never guessed.
 */
import type { ShadowDecisionRecord } from '../../../../core/routing/budget-store.js';
import { ROUTER_DIFFICULTIES, ROUTER_TASKS, summarizeDecisions } from './router-model.js';

export const FLOW_BY = [{ value: 'task', label: 'Kind of work' }, { value: 'difficulty', label: 'Difficulty' }, { value: 'source', label: 'Asked by' }] as const;
export type FlowBy = typeof FLOW_BY[number]['value'];
export type FlowSide = 'from' | 'to';
export interface FlowAt { side: FlowSide; index: number }
/** The node whose decisions the list under the diagram is held to. */
export interface FlowPin { by: FlowBy; side: FlowSide; key: string | null; label: string }

export interface FlowNode {
  /** What was asked, or the seat id; null = not recorded on the left, no seat found on the right. */
  key: string | null;
  label: string;
  count: number;
  /** Decisions here whose record says the work ran on another seat than the one chosen. */
  moved: number;
  /** Top of the node's row, the height of its bar and of its row, in pixels. */
  y: number;
  height: number;
  row: number;
}
export interface FlowLink {
  from: number;
  to: number;
  count: number;
  moved: number;
  fromY: number;
  toY: number;
  thickness: number;
}
export interface DecisionFlow {
  total: number;
  /** Pixels per decision, the same on both sides. */
  scale: number;
  height: number;
  from: FlowNode[];
  to: FlowNode[];
  links: FlowLink[];
}

/** The bars of a side add up to this many pixels unless that would make one decision thicker than FLOW_MAX_SCALE. */
export const FLOW_BODY = 168;
export const FLOW_MAX_SCALE = 12;
/** A row is never shorter than its label, whatever its count. */
export const FLOW_ROW = 26;
export const FLOW_GAP = 6;

const SOURCES: Record<string, string> = { daemon: 'Daemon', gateway: 'Gateway', 'best-of-n': 'Best of N', leader: 'Leader', verse: 'Console', test: 'Test' };
const NAMES: Record<FlowBy, Record<string, string>> = {
  task: Object.fromEntries(ROUTER_TASKS.map(task => [task.value, task.label])),
  difficulty: Object.fromEntries(ROUTER_DIFFICULTIES.map(level => [level.value, level.label])),
  source: SOURCES,
};
const WHAT: Record<FlowBy, string> = { task: 'kind of work', difficulty: 'difficulty', source: 'who asked' };
const LEVELS: readonly string[] = ROUTER_DIFFICULTIES.map(level => level.value);

/** What one record says was asked; null when it does not say. */
export function askedKey(record: ShadowDecisionRecord, by: FlowBy): string | null {
  const value: unknown = by === 'source' ? record.source : record.request?.[by];
  return typeof value === 'string' && value !== '' ? value : null;
}
export const askedLabel = (by: FlowBy, key: string | null): string => key === null ? 'Not recorded' : NAMES[by][key] ?? key;
const chosenSeat = (record: ShadowDecisionRecord): string | null => record.decision?.seatId ?? null;
const ranElsewhere = (record: ShadowDecisionRecord): boolean => !!record.actual && record.actual.seatId !== null && record.actual.seatId !== chosenSeat(record);

/** Whether a record belongs to the pinned node. */
export const pinMatches = (pin: FlowPin, record: ShadowDecisionRecord): boolean =>
  (pin.side === 'from' ? askedKey(record, pin.by) : chosenSeat(record)) === pin.key;

function place(nodes: FlowNode[], scale: number): number {
  let y = 0;
  for (const node of nodes) {
    node.y = y;
    node.height = Math.max(2, node.count * scale);
    node.row = Math.max(FLOW_ROW, node.height);
    y += node.row + FLOW_GAP;
  }
  return y - FLOW_GAP;
}

/** null when there is nothing to draw. Seats come most chosen first, as in the lanes above; difficulty keeps its own order, the other groupings go most asked first. */
export function decisionFlow(records: readonly ShadowDecisionRecord[], by: FlowBy, seatLabel: (seatId: string | null) => string): DecisionFlow | null {
  const total = records.length;
  if (total === 0) return null;
  const node = (key: string | null, label: string): FlowNode => ({ key, label, count: 0, moved: 0, y: 0, height: 0, row: 0 });
  const to = summarizeDecisions(records).seats.map(seat => node(seat.seatId, seatLabel(seat.seatId)));
  const asked = new Map<string | null, FlowNode>();
  const pairs = new Map<string, { fromKey: string | null; toKey: string | null; count: number; moved: number }>();
  for (const record of records) {
    const fromKey = askedKey(record, by), toKey = chosenSeat(record), moved = ranElsewhere(record) ? 1 : 0;
    const left = asked.get(fromKey) ?? node(fromKey, askedLabel(by, fromKey));
    asked.set(fromKey, left);
    const right = to.find(seat => seat.key === toKey)!;
    left.count += 1; left.moved += moved;
    right.count += 1; right.moved += moved;
    const id = JSON.stringify([fromKey, toKey]);
    const pair = pairs.get(id) ?? { fromKey, toKey, count: 0, moved: 0 };
    pairs.set(id, pair);
    pair.count += 1; pair.moved += moved;
  }
  const level = (key: string | null): number => key === null || !LEVELS.includes(key) ? LEVELS.length : LEVELS.indexOf(key);
  const from = [...asked.values()].sort((a, b) => (by === 'difficulty' ? level(a.key) - level(b.key) : b.count - a.count) || a.label.localeCompare(b.label));
  const scale = Math.min(FLOW_MAX_SCALE, FLOW_BODY / total);
  const height = Math.max(place(from, scale), place(to, scale));
  const links = [...pairs.values()].map((pair): FlowLink => ({
    from: from.findIndex(item => item.key === pair.fromKey), to: to.findIndex(item => item.key === pair.toKey),
    count: pair.count, moved: pair.moved, fromY: 0, toY: 0, thickness: pair.count * scale,
  }));
  // Bands leave a node in the order of the nodes they reach, so two bands from one node never cross.
  const stack = (side: FlowSide, other: FlowSide, nodes: FlowNode[]) => nodes.forEach((item, index) => {
    let y = item.y;
    for (const link of links.filter(candidate => candidate[side] === index).sort((a, b) => a[other] - b[other])) {
      if (side === 'from') link.fromY = y; else link.toY = y;
      y += link.thickness;
    }
  });
  stack('from', 'to', from);
  stack('to', 'from', to);
  return { total, scale, height, from, to, links: links.sort((a, b) => a.from - b.from || a.to - b.to) };
}

/** A band as a closed path in a box 100 wide: level out of the left node, level into the right one. */
export function ribbonPath(link: FlowLink): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  const a = round(link.fromY), b = round(link.toY), thick = Math.max(1, round(link.thickness));
  return `M0,${a} C50,${a} 50,${b} 100,${b} L100,${round(b + thick)} C50,${round(b + thick)} 50,${round(a + thick)} 0,${round(a + thick)} Z`;
}

const decisions = (count: number): string => count === 1 ? '1 decision' : `${count} decisions`;
const linksOf = (flow: DecisionFlow, at: FlowAt): FlowLink[] => flow.links.filter(link => link[at.side] === at.index);
export const linkTouches = (link: FlowLink, at: FlowAt): boolean => link[at.side] === at.index;

/** What the whole diagram shows, in one sentence. */
export function flowWords(flow: DecisionFlow, by: FlowBy): string {
  return `${decisions(flow.total)} by ${WHAT[by]}, each band as thick as its count.`;
}

/** One node in words: its count, then where its decisions went (or came from), most first, and how many ran elsewhere. */
export function nodeWords(flow: DecisionFlow, at: FlowAt): string {
  const node = flow[at.side][at.index];
  if (!node) return '';
  const other: FlowSide = at.side === 'from' ? 'to' : 'from';
  const parts = linksOf(flow, at).sort((a, b) => b.count - a.count || a[other] - b[other]).map(link => `${flow[other][link[other]]!.label} ${link.count}`).join(', ');
  return `${node.label}: ${node.count} of ${decisions(flow.total)}. ${at.side === 'from' ? 'Went to' : 'From'} ${parts}.${node.moved > 0 ? ` ${node.moved} ran on another seat.` : ''}`;
}

/** Where a key moves the node being read: Up and Down along a side, Home and End to its ends, Right and Left across the node's thickest band. null = not a move. */
export function stepNode(flow: DecisionFlow, at: FlowAt, key: string): FlowAt | null {
  const last = flow[at.side].length - 1;
  if (key === 'ArrowUp') return { side: at.side, index: Math.max(0, at.index - 1) };
  if (key === 'ArrowDown') return { side: at.side, index: Math.min(last, at.index + 1) };
  if (key === 'Home') return { side: at.side, index: 0 };
  if (key === 'End') return { side: at.side, index: last };
  if ((key === 'ArrowRight' && at.side === 'from') || (key === 'ArrowLeft' && at.side === 'to')) {
    const other: FlowSide = at.side === 'from' ? 'to' : 'from';
    const thickest = linksOf(flow, at).sort((a, b) => b.count - a.count || a[other] - b[other])[0];
    return thickest ? { side: other, index: thickest[other] } : null;
  }
  return null;
}
