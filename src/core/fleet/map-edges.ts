/**
 * Who messaged whom, as typed edges for the fleet map: `phm map edges`,
 * GET /api/verse/fleet/control/map-edges and the Map pane's message lines.
 *
 * Not a second bus or map: a read-only projection of the durable bus inbox
 * through the `phm messages` read (agent-messages.ts: scrubbed one-line
 * summaries) with the same agent-to-agent rule as the map's own message
 * lines (fleet-edges.ts). Names are routing labels, not proven identities.
 * A role or lane no label proves stays "unknown" / null.
 */
import { parseSince, projectAgentMessages, type AgentRef } from './agent-messages.js';
import { scanBusInbox, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
import { agentToAgent } from './fleet-edges.js';
import { ORG_LANES } from './org-map.js';

export const MAP_EDGES_DEFAULT_SINCE = '15m';
export const MAP_EDGE_SUMMARY_MAX = 80;
export const MAP_EDGE_ROLES = ['leader', 'lane', 'worker', 'unknown'] as const;
export type MapEdgeRole = typeof MAP_EDGE_ROLES[number];

/** Key order is the JSON contract. */
export interface MapEdgeAgent {
  name: string;
  /** Org role read from the label: the leader, a lane, a worker (a job or a lane's numbered agent), else unknown. */
  role: MapEdgeRole;
  lane: string | null;
  /** The node on `phm map` (`leader`, `lane:<name>`, `job:<id>`); null when the map does not draw this agent. */
  node: string | null;
}
export interface MapEdge {
  id: string;
  from: MapEdgeAgent;
  to: MapEdgeAgent;
  count: number;
  lastAt: string;
  /** First 80 characters of the newest message, one plain scrubbed line. */
  lastSummary: string;
}
export interface MapEdges {
  schema: 'fleet.map-edges.v1';
  version: 1;
  generatedAt: string;
  /** Messages at or after this instant are counted. */
  since: string;
  source: 'available' | 'missing' | 'unavailable';
  /** Newest edge first. Null when the bus could not be read (unknown, not zero). */
  edges: MapEdge[] | null;
  /** Every agent on an edge, by org role, names sorted. Null with `edges`. */
  agents: Record<MapEdgeRole, string[]> | null;
  messages: number | null;
  /** Damaged bus rows skipped while reading. */
  skipped: number;
}
export interface MapEdgesOptions extends BusInboxOptions {
  /** Exclusive upper time bound spelled like `since` (`10m`, `2h`, `1d`,
   * epoch ms or ISO): only messages received strictly before it count,
   * composing with `since` into one `[since, before)` window — a message
   * stamped exactly at the cutoff drops, so adjacent windows never
   * double-count it. Parsed under the read's own clock, so a relative
   * spelling resolves against the same `now` `since` does; an invalid value
   * makes the read null like a bad `since`. */
  before?: string;
}

const JOB = /^(?:job:)?((?:RQ|FIXUP|LAND|FIX)-[A-Z0-9][A-Z0-9-]{2,80})$/;
/** The map node and org role a routing label proves; `node` null when the map does not draw it. Shared with `phm agents messages`. */
export function mapEdgeAgent(ref: AgentRef): MapEdgeAgent {
  const { name } = ref, job = JOB.exec(name)?.[1];
  if (['executor', 'orchestrator', 'guardian', 'comms'].includes(name)) return { name, role: 'unknown', lane: null, node: `planner:${name}` };
  if (name === 'leader') return { name, role: 'leader', lane: null, node: 'leader' };
  if (ref.lane === name || (ORG_LANES as readonly string[]).includes(name)) return { name, role: 'lane', lane: name, node: `lane:${name}` };
  if (job) return { name, role: 'worker', lane: ref.lane, node: `job:${job}` };
  return { name, role: ref.lane ? 'worker' : 'unknown', lane: ref.lane, node: null };
}

/** Pure: bus receipts in, edges out. The same rows and clock always give the same JSON. `before` is the exclusive upper bound in epoch ms. */
export function buildMapEdges(scan: { source: MapEdges['source']; rows: readonly BusInboxReceipt[]; skipped?: number }, since: number, now: number, before?: number): MapEdges {
  const head = { schema: 'fleet.map-edges.v1' as const, version: 1 as const, generatedAt: new Date(now).toISOString(), since: new Date(since).toISOString(), source: scan.source };
  if (scan.source === 'unavailable') return { ...head, edges: null, agents: null, messages: null, skipped: scan.skipped ?? 0 };
  const edges = new Map<string, MapEdge>();
  const rows = scan.rows.filter(row => agentToAgent(row.envelope) && row.receivedAt >= since && row.receivedAt <= now
    && (before === undefined || row.receivedAt < before));
  // Newest first, so the first message seen on an edge is its last one.
  for (const message of projectAgentMessages(rows)) {
    const id = `${message.from.name}->${message.to.name}`, edge = edges.get(id);
    if (edge) edge.count++;
    else edges.set(id, { id, from: mapEdgeAgent(message.from), to: mapEdgeAgent(message.to), count: 1, lastAt: message.ts, lastSummary: message.summary.slice(0, MAP_EDGE_SUMMARY_MAX) });
  }
  const list = [...edges.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.id < b.id ? -1 : 1));
  const agents: Record<MapEdgeRole, string[]> = { leader: [], lane: [], worker: [], unknown: [] };
  for (const agent of list.flatMap(edge => [edge.from, edge.to])) if (!agents[agent.role].includes(agent.name)) agents[agent.role].push(agent.name);
  for (const role of MAP_EDGE_ROLES) agents[role].sort();
  return { ...head, edges: list, agents, messages: rows.length, skipped: scan.skipped ?? 0 };
}

/** The one read behind the CLI, the API and the pane. `since`/`options.before` take `10m`, `2h`, `1d`, epoch ms or an ISO time; null when either is none of those. */
export function readMapEdges(since: string = MAP_EDGES_DEFAULT_SINCE, options: MapEdgesOptions = {}): MapEdges | null {
  const now = (options.now ?? Date.now)(), from = parseSince(since, now);
  const beforeMs = options.before === undefined ? undefined : parseSince(options.before, now);
  if (from === null || beforeMs === null) return null;
  return buildMapEdges(scanBusInbox(options), from, now, beforeMs);
}

/** `phm map edges` for people: one line per edge, then who is who. */
export function formatMapEdgesText(result: MapEdges): string {
  if (!result.edges || !result.agents) return 'Agent messages: unknown (the agent bus could not be read).';
  const who = (agent: MapEdgeAgent) => `${agent.name} (${agent.role})`;
  const lines = result.edges.map(edge => `  ${who(edge.from)} -> ${who(edge.to)}: ${edge.count}, last ${edge.lastAt.slice(11, 19)}Z "${edge.lastSummary}"`);
  const roles = MAP_EDGE_ROLES.map(role => `${role}: ${result.agents![role].join(', ') || 'none'}`).join(' · ');
  return [`${result.messages} agent message${result.messages === 1 ? '' : 's'} on ${lines.length} line${lines.length === 1 ? '' : 's'} since ${result.since.slice(0, 16).replace('T', ' ')} UTC.`,
    ...lines, ...(lines.length ? [`By role: ${roles}`] : []),
    ...(result.skipped > 0 ? [`Skipped ${result.skipped} damaged bus record${result.skipped === 1 ? '' : 's'}.`] : [])].join('\n');
}
