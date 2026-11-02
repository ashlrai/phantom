import { liveNodeRows } from './graph-live-model.js';
import type { GraphLiveData, GraphLiveState } from './graph-live-queries.js';
import type { AgentRoutesReply } from './agent-routes-query.js';

export function agentChoices(data: GraphLiveData): Array<{ id: string; label: string }> {
  return data.live.nodes.flatMap(node => {
    if (node.kind !== 'agent' || !('agentId' in node) || typeof node.agentId !== 'string') return [];
    return [{ id: node.agentId, label: node.agentId }];
  });
}

export interface RouteRow {
  resourceId: string;
  kind: string;
  label: string;
  state: GraphLiveState | 'untracked';
  edgeLabel: string;
  stateText: string;
}

export function routeRows(reply: AgentRoutesReply, nowMs: number): RouteRow[] {
  const nodes = new Map(liveNodeRows({ v: 1, live: reply.live }, nowMs).map(node => [node.id, node]));
  return reply.edges.map(edge => {
    const node = nodes.get(edge.to);
    return {
      resourceId: edge.to, kind: node?.kind ?? 'unknown', label: node?.label ?? edge.to,
      state: node?.state ?? 'untracked', edgeLabel: edge.kind.replaceAll('-', ' '),
      stateText: node ? `${node.state} · ${node.usedText} · ${node.resetText} · ${node.ageText}` : 'untracked',
    };
  });
}

export function routesHeadline(agentId: string, rows: RouteRow[]): string {
  const held = rows.filter(row => row.state === 'held').length;
  return `${agentId} reaches ${rows.length} ${rows.length === 1 ? 'resource' : 'resources'}${held ? ` · ${held} held` : ''}`;
}
