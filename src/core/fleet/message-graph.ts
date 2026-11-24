/**
 * Recent agent messages as edges grouped by organization: `phm fleet
 * message-graph`, GET /api/fleet/message-graph and the Fleet map's Messages list.
 *
 * Not a second bus or map: the `phm map edges` read (map-edges.ts) regrouped.
 * An agent's organization is the company behind its lane (provider.ts); an
 * agent whose label proves no lane, the leader included, reads "unknown".
 * Names, counts and times only: no message text leaves this read.
 */
import type { BusInboxOptions } from './bus-inbox.js';
import { MAP_EDGES_QUERY_KEYS, readMapEdges, type MapEdgeAgent, type MapEdges, type MapEdgesFlags, type MapEdgesOptions } from './map-edges.js';
import { PROVIDER_NAMES, providerFor, type ProviderName } from './provider.js';

export const MESSAGE_GRAPH_PATH = '/api/fleet/message-graph';

/** Key order is the JSON contract. */
export interface MessageGraphEdge { id: string; from: string; to: string; count: number; lastAt: string }
/** Every edge from one organization to another. `count` is the sum of its edges, `lastAt` the newest of them. */
export interface MessageGraphGroup { id: string; from: ProviderName; to: ProviderName; count: number; lastAt: string; edges: MessageGraphEdge[] }
export interface MessageGraphOrganization { name: ProviderName; agents: string[]; sent: number; received: number }
export interface FleetMessageGraph {
  schema: 'fleet.message-graph.v1';
  version: 1;
  generatedAt: string;
  /** Messages at or after this instant are counted. */
  since: string;
  source: MapEdges['source'];
  /** Organizations with an agent on an edge, in provider order, "unknown" last. Null when the bus could not be read (unknown, not zero). */
  organizations: MessageGraphOrganization[] | null;
  /** Newest group first; edges inside a group newest first. Null with `organizations`. */
  groups: MessageGraphGroup[] | null;
  messages: number | null;
  /** Damaged bus rows skipped while reading. */
  skipped: number;
}

/** Only a proven lane names an organization: a bare agent name is never matched against brand words. */
export const organizationOf = (agent: Pick<MapEdgeAgent, 'lane'>): ProviderName => providerFor(agent.lane).name;

/** Pure: map edges in, grouped edges out. The same edges always give the same JSON. */
export function buildMessageGraph(read: MapEdges): FleetMessageGraph {
  const head = { schema: 'fleet.message-graph.v1' as const, version: 1 as const, generatedAt: read.generatedAt, since: read.since, source: read.source };
  if (!read.edges) return { ...head, organizations: null, groups: null, messages: null, skipped: read.skipped };
  const groups = new Map<string, MessageGraphGroup>(), organizations = new Map<ProviderName, MessageGraphOrganization>();
  const member = (name: ProviderName, agent: string) => {
    const organization = organizations.get(name) ?? { name, agents: [], sent: 0, received: 0 };
    if (!organization.agents.includes(agent)) organization.agents.push(agent);
    organizations.set(name, organization);
    return organization;
  };
  // Map edges arrive newest first, so the first edge seen in a group carries its last time.
  for (const edge of read.edges) {
    const from = organizationOf(edge.from), to = organizationOf(edge.to), id = `${from}->${to}`;
    const group = groups.get(id) ?? { id, from, to, count: 0, lastAt: edge.lastAt, edges: [] };
    group.count += edge.count;
    group.edges.push({ id: edge.id, from: edge.from.name, to: edge.to.name, count: edge.count, lastAt: edge.lastAt });
    groups.set(id, group);
    member(from, edge.from.name).sent += edge.count;
    member(to, edge.to.name).received += edge.count;
  }
  for (const organization of organizations.values()) organization.agents.sort();
  return { ...head, organizations: PROVIDER_NAMES.flatMap(name => organizations.get(name) ?? []), groups: [...groups.values()], messages: read.messages, skipped: read.skipped };
}

/**
 * The one read behind the CLI, the API and the Fleet map: the `phm map edges`
 * read — `agentToAgent` rows inside the `[since, before)` window, then the
 * shared `phm messages` filters inside `matchAgentMessages` — regrouped by
 * organization. Every flag `phm map edges` takes narrows the counted set the
 * same way, so "which organizations talked about job X" is one filtered read
 * here too. A malformed flag is a usage error, never a guessed window.
 */
export function readMessageGraph(input: MapEdgesFlags = {}, options: MapEdgesOptions = {}):
  { ok: true; result: FleetMessageGraph } | { ok: false; error: string } {
  const edges = readMapEdges(input, options);
  if (!edges.ok) return edges;
  return { ok: true, result: buildMessageGraph(edges.result) };
}

/** GET /api/fleet/message-graph[?since=10m&before=1h&…]: 200 the graph, 400 a bad query, 503 the typed "unknown" graph. */
export function messageGraphResponse(url: string, options: BusInboxOptions = {}): { status: 200 | 400 | 503; body: FleetMessageGraph | { error: string } } {
  const params = new URL(url, 'http://localhost').searchParams;
  const keys = [...params.keys()];
  if (keys.some(key => !(MAP_EDGES_QUERY_KEYS as readonly string[]).includes(key)) ||
      keys.some(key => params.getAll(key).length > 1)) {
    return { status: 400, body: { error: `Use each filter at most once: ${MAP_EDGES_QUERY_KEYS.join(', ')}.` } };
  }
  const input: MapEdgesFlags = {};
  for (const key of MAP_EDGES_QUERY_KEYS) {
    const value = params.get(key);
    if (value !== null) (input as Record<string, string>)[key] = value;
  }
  const graph = readMessageGraph(input, options);
  if (!graph.ok) return { status: 400, body: { error: graph.error } };
  return { status: graph.result.source === 'unavailable' ? 503 : 200, body: graph.result };
}

/** `phm fleet message-graph` for people: one line per pair of organizations, then its agent lines. */
export function formatMessageGraphText(graph: FleetMessageGraph): string {
  if (!graph.groups || !graph.organizations) return 'Agent messages: unknown (the agent bus could not be read).';
  const plural = (n: number | null, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [`${plural(graph.messages, 'agent message')} between ${plural(graph.organizations.length, 'organization')} since ${graph.since.slice(0, 16).replace('T', ' ')} UTC.`,
    ...graph.groups.flatMap(group => [`${group.from} -> ${group.to}: ${group.count}, last ${group.lastAt.slice(11, 19)}Z`,
      ...group.edges.map(edge => `  ${edge.from} -> ${edge.to}: ${edge.count}`)]),
    ...(graph.skipped > 0 ? [`Skipped ${plural(graph.skipped, 'damaged bus record')}.`] : [])].join('\n');
}
