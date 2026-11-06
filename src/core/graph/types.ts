import type { VerseSeat } from '../verse/types.js';

/** Inventory only: none of these declarations grant execution authority. */
export type RegistryNode =
  | { id: string; kind: 'agent'; agentId: string }
  | { id: string; kind: 'engine-account'; engine: string; accountId: string; seatIds: string[] }
  | { id: string; kind: 'model'; engine: string; modelId: string }
  | { id: string; kind: 'mcp'; serverId: string };

export type AgentRelationship = 'can-message' | 'can-delegate' | 'reviews';
export type RegistryEdgeKind = AgentRelationship | 'routes-to';
export interface RegistryEdge {
  id: string;
  kind: RegistryEdgeKind;
  from: string;
  to: string;
  source: 'fleet' | 'seats';
}

/** The public identity/catalog subset of Verse seats, never their launchers. */
export type RegistrySeat = Pick<VerseSeat, 'id' | 'accountId'> & {
  engine: string;
  models: Array<Pick<VerseSeat['models'][number], 'id'>>;
};

export interface FleetGraphSeed {
  schema: 'fleet.v1';
  agents: Array<{ id: string; seatId?: string; modelId?: string; mcpIds?: string[] }>;
  mcp: Array<{ id: string }>;
  /** Bare agent IDs; routing comes from each agent's explicit bindings. */
  edges: Array<{ kind: AgentRelationship; from: string; to: string }>;
}

export type GraphSourceState = 'loaded' | 'missing' | 'invalid' | 'unavailable';
export interface GraphIssue {
  source: 'fleet' | 'seats';
  code: 'missing' | 'invalid' | 'unavailable' | 'unknown-seat' | 'unknown-model' | 'unknown-mcp' | 'unknown-agent';
}

export interface RegistryGraph {
  schema: 'graph.v1';
  readOnly: true;
  complete: boolean;
  sources: { fleet: GraphSourceState; seats: GraphSourceState };
  nodes: RegistryNode[];
  edges: RegistryEdge[];
  issues: GraphIssue[];
}
