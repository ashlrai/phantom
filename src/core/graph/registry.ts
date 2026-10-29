import type {
  AgentRelationship, FleetGraphSeed, GraphIssue, RegistryEdge, RegistryEdgeKind,
  RegistryGraph, RegistryNode, RegistrySeat,
} from './types.js';

const RELATIONSHIPS: readonly AgentRelationship[] = ['can-message', 'can-delegate', 'reviews'];
const MAX_ROWS = 10_000;
const EMPTY_FLEET: FleetGraphSeed = { schema: 'fleet.v1', agents: [], mcp: [], edges: [] };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid graph record');
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  // Metadata fields are identifiers, never free-form notes, commands or URLs.
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/+%-]{0,255}$/.test(value)) {
    throw new Error('Invalid graph identifier');
  }
  return value;
}

function rows(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new Error('Invalid graph list');
  return Array.from(value);
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) throw new Error('Duplicate graph identifier');
  return values;
}

/** Allowlist fields before serialization; unrelated config/credential fields are discarded. */
export function parseFleetGraphSeed(value: unknown): FleetGraphSeed {
  const seed = record(value);
  if (seed.schema !== 'fleet.v1') throw new Error('Unsupported fleet schema');
  const agents = unique(rows(seed.agents).map((value) => {
    const agent = record(value);
    const id = identifier(agent.id);
    const seatId = agent.seatId === undefined ? undefined : identifier(agent.seatId);
    const modelId = agent.modelId === undefined ? undefined : identifier(agent.modelId);
    if (modelId !== undefined && seatId === undefined) throw new Error('Model requires seat');
    const mcpIds = agent.mcpIds === undefined ? undefined : unique(rows(agent.mcpIds).map(identifier), id => id);
    return { id, ...(seatId === undefined ? {} : { seatId }), ...(modelId === undefined ? {} : { modelId }),
      ...(mcpIds === undefined ? {} : { mcpIds }) };
  }), agent => agent.id);
  const mcp = unique(rows(seed.mcp).map(value => ({ id: identifier(record(value).id) })), server => server.id);
  const edges = rows(seed.edges).map(value => {
    const edge = record(value);
    if (!RELATIONSHIPS.includes(edge.kind as AgentRelationship)) throw new Error('Invalid agent relationship');
    return { kind: edge.kind as AgentRelationship, from: identifier(edge.from), to: identifier(edge.to) };
  });
  return { schema: 'fleet.v1', agents, mcp, edges };
}

/** Accept a public seats array or an exported {seats:[...]} response. */
export function parseRegistrySeats(value: unknown): RegistrySeat[] {
  return unique(rows(Array.isArray(value) ? value : record(value).seats).map(value => {
    const seat = record(value);
    const engine = identifier(seat.engine);
    // Registry providers can grow independently of the current Verse UI union.
    return { id: identifier(seat.id), engine, accountId: identifier(seat.accountId),
      models: unique(rows(seat.models).map(value => ({ id: identifier(record(value).id) })), model => model.id) };
  }), seat => seat.id);
}

/** Encode components separately so slashes/colons cannot alias another identity. */
export function registryNodeId(kind: RegistryNode['kind'], ...parts: string[]): string {
  return `${kind}:${parts.map(part => encodeURIComponent(part)).join('/')}`;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Pure deterministic projection. Invalid sources are withheld, never treated as healthy empty inventories. */
export function buildRegistryGraph(fleetInput: unknown, seatsInput: unknown): RegistryGraph {
  const graph: RegistryGraph = { schema: 'graph.v1', readOnly: true, complete: true,
    sources: { fleet: 'loaded', seats: 'loaded' }, nodes: [], edges: [], issues: [] };
  let fleet = EMPTY_FLEET;
  let seats: RegistrySeat[] = [];
  const issue = (source: GraphIssue['source'], code: GraphIssue['code']): void => {
    if (!graph.issues.some(item => item.source === source && item.code === code)) graph.issues.push({ source, code });
  };
  try { fleet = parseFleetGraphSeed(fleetInput); }
  catch { graph.sources.fleet = 'invalid'; issue('fleet', 'invalid'); }
  try { seats = parseRegistrySeats(seatsInput); }
  catch { graph.sources.seats = 'invalid'; issue('seats', 'invalid'); }

  const nodes = new Map<string, RegistryNode>();
  const edges = new Map<string, RegistryEdge>();
  const addEdge = (kind: RegistryEdgeKind, from: string, to: string, source: RegistryEdge['source']): void => {
    const id = `${kind}:${encodeURIComponent(from)}/${encodeURIComponent(to)}`;
    edges.set(id, { id, kind, from, to, source });
  };
  for (const seat of seats) {
    const id = registryNodeId('engine-account', seat.engine, seat.accountId);
    const existing = nodes.get(id);
    if (existing?.kind === 'engine-account') existing.seatIds.push(seat.id);
    else nodes.set(id, { id, kind: 'engine-account', engine: seat.engine, accountId: seat.accountId, seatIds: [seat.id] });
    for (const model of seat.models) {
      const modelId = registryNodeId('model', seat.engine, model.id);
      nodes.set(modelId, { id: modelId, kind: 'model', engine: seat.engine, modelId: model.id });
      addEdge('routes-to', id, modelId, 'seats');
    }
  }
  for (const server of fleet.mcp) {
    const id = registryNodeId('mcp', server.id);
    nodes.set(id, { id, kind: 'mcp', serverId: server.id });
  }
  for (const agent of fleet.agents) {
    const id = registryNodeId('agent', agent.id);
    nodes.set(id, { id, kind: 'agent', agentId: agent.id });
  }
  const seatsById = new Map(seats.map(seat => [seat.id, seat]));
  for (const agent of fleet.agents) {
    const id = registryNodeId('agent', agent.id);
    if (agent.seatId !== undefined) {
      const seat = seatsById.get(agent.seatId);
      if (!seat) issue('fleet', 'unknown-seat');
      else {
        addEdge('routes-to', id, registryNodeId('engine-account', seat.engine, seat.accountId), 'fleet');
        if (agent.modelId !== undefined) {
          if (seat.models.some(model => model.id === agent.modelId)) {
            addEdge('routes-to', id, registryNodeId('model', seat.engine, agent.modelId), 'fleet');
          } else issue('fleet', 'unknown-model');
        }
      }
    }
    for (const server of agent.mcpIds ?? []) {
      const to = registryNodeId('mcp', server);
      if (nodes.has(to)) addEdge('routes-to', id, to, 'fleet');
      else issue('fleet', 'unknown-mcp');
    }
  }
  for (const edge of fleet.edges) {
    const from = registryNodeId('agent', edge.from);
    const to = registryNodeId('agent', edge.to);
    if (nodes.has(from) && nodes.has(to)) addEdge(edge.kind, from, to, 'fleet');
    else issue('fleet', 'unknown-agent');
  }
  for (const node of nodes.values()) if (node.kind === 'engine-account') node.seatIds.sort(compare);
  graph.nodes = [...nodes.values()].sort((a, b) => compare(a.id, b.id));
  graph.edges = [...edges.values()].sort((a, b) => compare(a.id, b.id));
  graph.issues.sort((a, b) => compare(`${a.source}/${a.code}`, `${b.source}/${b.code}`));
  graph.complete = graph.issues.length === 0;
  return graph;
}
