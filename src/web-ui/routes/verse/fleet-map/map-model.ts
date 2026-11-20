/**
 * The Map pane's read and 2D layout. The read is GET /api/verse/fleet/control/live-map,
 * the same fleet.live-map.v1 graph `phm map --json` prints; the layout is pure.
 * The message lines' last words come from GET /api/verse/fleet/control/map-edges (`phm map edges --json`),
 * and each line's card of its last 5 messages from GET /api/verse/fleet/control/agent-messages (`phm agents messages --json`).
 */
import type { FleetLiveMap, LiveMapEdge, LiveMapEdgeKind, LiveMapNode, LiveMapNodeKind } from '../../../../core/fleet/live-map.js';
import type { MapEdge, MapEdgeAgent, MapEdgeRole } from '../../../../core/fleet/map-edges.js';
import type { AgentsMessagePair } from '../../../../core/fleet/agents-messages.js';
import { MAP_STATES, type MapFilter, type MapState } from '../../../../core/fleet/map-filter.js';
import { narrowLaneHealth } from '../../../../core/fleet/lane-badge.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const LIVE_MAP_API = '/api/verse/fleet/control/live-map';
/** The pane polls no faster than the server rebuilds the graph. */
export const MAP_POLL_MS = 5_000;
const MAX_NODES = 400, MAX_EDGES = 1200, MAX_TEXT = 160;
const NODE_KINDS: readonly LiveMapNodeKind[] = ['leader', 'lane', 'job', 'computer', 'resource'];
const EDGE_KINDS: readonly LiveMapEdgeKind[] = ['reports-to', 'runs-on', 'uses-resource', 'messaged-in-last-15-min'];

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v.slice(0, MAX_TEXT) : null;
const count = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** Malformed rows are dropped and malformed fields read "unknown"; nothing is invented. Null when this is not a live map. */
export function narrowLiveMap(raw: unknown): FleetLiveMap | null {
  if (!object(raw) || raw.schema !== 'fleet.live-map.v1' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
  const nodes: LiveMapNode[] = [], known = new Set<string>();
  for (const row of raw.nodes.slice(0, MAX_NODES)) {
    const id = object(row) ? text(row.id) : null, kind = object(row) ? row.kind as LiveMapNodeKind : null;
    if (!object(row) || !id || !kind || !NODE_KINDS.includes(kind) || known.has(id)) continue;
    known.add(id);
    nodes.push({ id, kind, level: count(row.level) ?? NODE_KINDS.indexOf(kind), label: text(row.label) ?? id,
      provider: (text(row.provider) ?? 'unknown') as LiveMapNode['provider'], status: text(row.status) ?? 'unknown',
      detail: text(row.detail) ?? 'unknown', live: typeof row.live === 'boolean' ? row.live : null,
      ...(kind === 'lane' && narrowLaneHealth(row.health) ? { health: narrowLaneHealth(row.health) } : {}),
      ...(kind === 'lane' && (row.mergedPerHour === null || typeof row.mergedPerHour === 'number') ? { mergedPerHour: row.mergedPerHour } : {}),
      ...(kind === 'job' ? { lane: text(row.lane), repo: text(row.repo), ...(MAP_STATES.includes(row.state as MapState) ? { state: row.state as MapState } : {}) } : {}),
      ...(kind === 'resource' && (row.usedPct === null || typeof row.usedPct === 'number') ? { usedPct: row.usedPct } : {}) });
  }
  const edges: LiveMapEdge[] = [];
  for (const row of raw.edges.slice(0, MAX_EDGES)) {
    if (!object(row) || !EDGE_KINDS.includes(row.kind as LiveMapEdgeKind) || !known.has(row.from as string) || !known.has(row.to as string)) continue;
    const lastAt = text(row.lastMessageAt);
    edges.push({ id: text(row.id) ?? `${String(row.kind)}:${String(row.from)}->${String(row.to)}`, kind: row.kind as LiveMapEdgeKind,
      from: row.from as string, to: row.to as string, messages: count(row.messages),
      lastMessageAt: lastAt && Number.isFinite(Date.parse(lastAt)) ? lastAt : null, pulse: row.pulse === true });
  }
  const sources = object(raw.sources) ? raw.sources : {};
  const source = (key: string) => sources[key] === 'available' ? 'available' as const : 'unknown' as const;
  const counts = object(raw.counts) ? raw.counts : {};
  const kinds = (kind: LiveMapNodeKind) => nodes.filter(node => node.kind === kind).length;
  return {
    schema: 'fleet.live-map.v1', generatedAt: text(raw.generatedAt) ?? 'unknown',
    windowMinutes: count(raw.windowMinutes) ?? 15, pulseSeconds: count(raw.pulseSeconds) ?? 60, nodes, edges,
    counts: { lanes: kinds('lane'), jobs: kinds('job'), computers: kinds('computer'), resources: kinds('resource'), messages: count(counts.messages) },
    sources: { org: source('org'), jobs: source('jobs'), computers: source('computers'), resources: source('resources'),
      messages: ['available', 'missing', 'unavailable'].includes(sources.messages as string) ? sources.messages as 'available' : 'unknown' },
    unmappedMessages: count(raw.unmappedMessages),
    gaps: Array.isArray(raw.gaps) ? raw.gaps.map(text).filter((gap): gap is string => gap !== null).slice(0, 20) : [],
  };
}

export const liveMapQuery: QueryDef<FleetLiveMap | null> = {
  key: 'verse-fleet-live-map',
  fetch: async signal => narrowLiveMap(await apiGet<unknown>(LIVE_MAP_API, signal)),
};

const ROLES: readonly MapEdgeRole[] = ['leader', 'lane', 'worker'];
/** The edges of a fleet.map-edges.v1 read, malformed rows dropped. Null when the read is something else or the bus is unknown. */
export function narrowMapEdges(raw: unknown): MapEdge[] | null {
  if (!object(raw) || raw.schema !== 'fleet.map-edges.v1' || raw.version !== 1 || !Array.isArray(raw.edges)) return null;
  const agent = (v: unknown): MapEdgeAgent | null => object(v) && text(v.name)
    ? { name: text(v.name)!, role: ROLES.find(role => role === v.role) ?? 'unknown', lane: text(v.lane), node: text(v.node) } : null;
  return raw.edges.slice(0, MAX_EDGES).flatMap(row => {
    const from = object(row) ? agent(row.from) : null, to = object(row) ? agent(row.to) : null;
    const lastAt = object(row) ? text(row.lastAt) : null, n = object(row) ? count(row.count) : null;
    if (!object(row) || !from || !to || !lastAt || !Number.isFinite(Date.parse(lastAt)) || n === null) return [];
    return [{ id: `${from.name}->${to.name}`, from, to, count: n, lastAt, lastSummary: (text(row.lastSummary) ?? 'unknown').slice(0, 80) }];
  });
}
export const MAP_EDGES_API = '/api/verse/fleet/control/map-edges';
export const mapEdgesQuery: QueryDef<MapEdge[] | null> = {
  key: 'verse-fleet-map-edges',
  fetch: async signal => narrowMapEdges(await apiGet<unknown>(MAP_EDGES_API, signal)),
};

/** Per-line weights and last summaries from agents.messages.v1, keyed `from->to` by map node id. Null when the read is something else or the bus is unknown. */
export function narrowMessagePairs(raw: unknown): Map<string, AgentsMessagePair> | null {
  if (!object(raw) || raw.schema !== 'agents.messages.v1' || raw.version !== 1 || !Array.isArray(raw.pairs)) return null;
  const pairs = new Map<string, AgentsMessagePair>();
  for (const row of raw.pairs.slice(0, MAX_EDGES)) {
    const from = object(row) ? text(row.from) : null, to = object(row) ? text(row.to) : null, n = object(row) ? count(row.count) : null;
    const lastAt = object(row) ? text(row.lastAt) : null;
    if (!object(row) || !from || !to || n === null || !lastAt || !Array.isArray(row.recent)) continue;
    const recent = row.recent.slice(0, 5).flatMap(item => object(item) && text(item.at) && text(item.summary)
      ? [{ at: text(item.at)!, kind: (text(item.kind) ?? 'status') as AgentsMessagePair['recent'][number]['kind'], summary: text(item.summary)! }] : []);
    pairs.set(`${from}->${to}`, { from, to, count: n, lastAt, recent });
  }
  return pairs;
}
export const AGENT_MESSAGES_API = '/api/verse/fleet/control/agent-messages';
export const messagePairsQuery: QueryDef<Map<string, AgentsMessagePair> | null> = {
  key: 'verse-fleet-agent-messages',
  fetch: async signal => narrowMessagePairs(await apiGet<unknown>(AGENT_MESSAGES_API, signal)),
};

export const NODE_W = 140, NODE_H = 52;
const COLUMN = 156, ROW = 104, PAD = 16;
export interface PlacedNode extends LiveMapNode { x: number; y: number }
export interface MapLayout { width: number; height: number; nodes: PlacedNode[]; at: Map<string, PlacedNode> }

/**
 * Rows by org level (leader, lanes, jobs, computers, resources), empty rows skipped. Each job sits in
 * lane order under the lane it reports to, and each resource under the lane that uses it, so lines stay short.
 */
export function layoutLiveMap(map: FleetLiveMap): MapLayout {
  const parent = new Map<string, string>();
  for (const edge of map.edges) {
    if (edge.kind === 'reports-to') parent.set(edge.from, edge.to);
    if (edge.kind === 'uses-resource') parent.set(edge.to, edge.from);
  }
  const levels = [...new Set(map.nodes.map(node => node.level))].sort((a, b) => a - b);
  const rows = levels.map(level => map.nodes.filter(node => node.level === level));
  const width = Math.max(COLUMN * 4, ...rows.map(row => row.length * COLUMN)) + PAD * 2;
  const at = new Map<string, PlacedNode>(), placed: PlacedNode[] = [];
  rows.forEach((row, index) => {
    const rank = (node: LiveMapNode) => { const up = parent.get(node.id); return up && at.has(up) ? at.get(up)!.x : Number.MAX_SAFE_INTEGER; };
    const ordered = row.map((node, order) => ({ node, order })).sort((a, b) => rank(a.node) - rank(b.node) || a.order - b.order);
    const step = (width - PAD * 2) / ordered.length;
    ordered.forEach(({ node }, i) => {
      const place = { ...node, x: Math.round(PAD + step * (i + 0.5)), y: PAD + NODE_H / 2 + index * ROW };
      at.set(node.id, place); placed.push(place);
    });
  });
  return { width, height: PAD * 2 + NODE_H + Math.max(0, rows.length - 1) * ROW, nodes: placed, at };
}

/**
 * Pulse when the newest message is within the pulse window of `now`; the server's flag when no time is known.
 * Never under reduced motion: the line is still thicker and listed, it just does not move.
 */
export function pulsing(edge: LiveMapEdge, map: FleetLiveMap, now: number, reducedMotion = false): boolean {
  if (reducedMotion) return false;
  if (!edge.lastMessageAt) return edge.pulse;
  const age = now - Date.parse(edge.lastMessageAt);
  return age <= map.pulseSeconds * 1000 && age >= -map.pulseSeconds * 1000;
}

/**
 * How solid a message line draws: 1 for a message just now, falling in a straight line to 0.25 at the
 * edge of the window. A line with no known time stays at 0.6 (unknown, not fresh).
 */
export function edgeOpacity(edge: LiveMapEdge, map: FleetLiveMap, now: number): number {
  if (!edge.lastMessageAt) return 0.6;
  const span = map.windowMinutes * 60_000, age = Math.min(Math.max(now - Date.parse(edge.lastMessageAt), 0), span);
  return Math.round((1 - 0.75 * (age / span)) * 100) / 100;
}

/** "2 jobs on 3 computers · 5 messages in 15 minutes", with unknown spelled out. */
export function mapHeadline(map: FleetLiveMap): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const jobs = map.sources.jobs === 'available' || map.counts.jobs ? plural(map.counts.jobs, 'job') : 'jobs unknown';
  const computers = map.sources.computers === 'available' ? plural(map.counts.computers, 'computer') : 'computers unknown';
  const messages = map.counts.messages === null ? 'messages unknown' : `${plural(map.counts.messages, 'message')} in ${map.windowMinutes} minutes`;
  return `${jobs} · ${computers} · ${messages}`;
}

/** Nothing to draw beyond the leader. */
export const emptyMap = (map: FleetLiveMap) => map.nodes.every(node => node.kind === 'leader');

/** One count for both directions; an unknown direction makes the total unknown. */
export function messagePairs(map: FleetLiveMap): { key: string; edge: LiveMapEdge; count: number | null }[] {
  const pairs = new Map<string, { key: string; edge: LiveMapEdge; count: number | null }>();
  for (const edge of map.edges) {
    if (edge.kind !== 'messaged-in-last-15-min' || edge.from === edge.to) continue;
    const key = JSON.stringify([edge.from, edge.to].sort());
    const pair = pairs.get(key);
    if (!pair) pairs.set(key, { key, edge, count: edge.messages });
    else pair.count = pair.count === null || edge.messages === null ? null : pair.count + edge.messages;
  }
  return [...pairs.values()];
}

/** Bow same-row messages into the gap above the nodes; return the curve's actual midpoint. */
export function messageCurve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const row = a.y === b.y;
  const cx = (a.x + b.x) / 2 + (row ? 0 : 40 * (a.x <= b.x ? 1 : -1));
  const cy = (a.y + b.y) / 2 - (row ? NODE_H + 36 : 40);
  return { d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`, mid: { x: (a.x + 2 * cx + b.x) / 4, y: (a.y + 2 * cy + b.y) / 4 } };
}

export const MAP_FILTER_KEY = 'phantom.fleet-map.filter';
/** The filters picked earlier in this browser session; none when nothing was picked or storage is blocked. */
export function readMapFilter(): MapFilter {
  try {
    const raw: unknown = JSON.parse(globalThis.sessionStorage?.getItem(MAP_FILTER_KEY) ?? 'null');
    if (!object(raw)) return {};
    return { lane: text(raw.lane), repo: text(raw.repo), state: MAP_STATES.find(state => state === raw.state) ?? null };
  } catch { return {}; }
}
export function saveMapFilter(filter: MapFilter): void {
  try { globalThis.sessionStorage?.setItem(MAP_FILTER_KEY, JSON.stringify(filter)); } catch { /* storage blocked: the filter lasts until the page closes */ }
}
