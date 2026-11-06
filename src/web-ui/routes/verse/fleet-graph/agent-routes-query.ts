import type { RegistryEdge } from '../../../../core/graph/types.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowGraphLive, type GraphLiveData } from './graph-live-queries.js';

// Kept local to avoid importing the server handler and its Node dependencies into the browser.
const VERSE_FLEET_GRAPH_LIVE_PATH = '/api/verse/fleet/graph/live';
export const validAgentId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_.:@/+%-]{0,255}$(?![\s\S])/.test(id);

export interface AgentRoutesReply {
  scope: { kind: 'agent'; agentId: string };
  edges: RegistryEdge[];
  live: GraphLiveData['live'];
}

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function narrowAgentRoutes(x: unknown, agentId: string): AgentRoutesReply | null {
  const graph = narrowGraphLive(x);
  if (!graph || !record(x) || !record(x.scope) || x.scope.kind !== 'agent' || x.scope.agentId !== agentId
    || !Array.isArray(x.edges) || !x.edges.every(edge => record(edge) && typeof edge.id === 'string'
      && edge.kind === 'routes-to' && typeof edge.from === 'string' && typeof edge.to === 'string'
      && (edge.source === 'fleet' || edge.source === 'seats'))) return null;
  return { scope: { kind: 'agent', agentId }, edges: x.edges as RegistryEdge[], live: graph.live };
}

export function agentRoutesQuery(agentId: string): QueryDef<AgentRoutesReply | null> {
  return {
    key: `verse-fleet-graph-agent:${agentId}`,
    fetch: async signal => {
      if (!validAgentId(agentId)) throw new Error('Invalid agent identifier.');
      const result = await apiGet<unknown>(`${VERSE_FLEET_GRAPH_LIVE_PATH}?agent=${encodeURIComponent(agentId)}`, signal);
      return narrowAgentRoutes(result, agentId);
    },
  };
}
