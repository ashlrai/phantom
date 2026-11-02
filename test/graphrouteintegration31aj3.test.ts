import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_GRAPH_SEED_KIND,
  FLEET_GRAPH_SEED_LIMITS,
  seedFleetGraph,
  type FleetGraphSeedV1,
} from '../src/core/fleet/graph-seed.js';
import { buildRegistryGraph } from '../src/core/graph/registry.js';
import type { RegistryGraph } from '../src/core/graph/types.js';

vi.mock('../src/core/fleet/graph-seed.js', async (original) => ({
  ...await original<typeof import('../src/core/fleet/graph-seed.js')>(),
  seedFleetGraph: vi.fn(),
}));
import { loadGraph } from '../src/core/graph/loader.js';
import { cmdGraph } from '../src/cli/graph.js';

/**
 * Day-one flow: a fleet.v1 seed and a public seats snapshot are persisted,
 * buildRegistryGraph projects them into graph.v1, and the public `phm graph`
 * command inspects the projection through the real loader. Only the store
 * read (seedFleetGraph) is substituted — the same seam the live loader tests
 * use — so registry.ts, loader.ts and cli/graph.ts all run for real.
 */
const reader = vi.mocked(seedFleetGraph);
const MARKER = 'FAKE-CREDENTIAL-31AJ3';
const GENERATED_AT = '2026-10-31T00:33:00.000Z';

const FLEET_SEED = {
  schema: 'fleet.v1',
  agents: [
    { id: 'planner/lead', seatId: 'codex-team', modelId: 'gpt-5.1', mcpIds: ['locus', 'phantom-secrets'] },
    { id: 'ops:eu', seatId: 'claude-team', modelId: 'sonnet-4.6' },
    { id: 'reviewer' },
  ],
  mcp: [{ id: 'locus' }, { id: 'phantom-secrets' }],
  edges: [
    { kind: 'can-delegate', from: 'planner/lead', to: 'ops:eu' },
    { kind: 'can-message', from: 'ops:eu', to: 'planner/lead' },
    { kind: 'reviews', from: 'reviewer', to: 'planner/lead' },
  ],
};

/** Public seat rows carrying private launcher/credential halves that must never project. */
const SEATS_SNAPSHOT = {
  seats: [
    {
      id: 'codex-team', engine: 'codex', accountId: 'team/shared',
      models: [{ id: 'gpt-5.1', label: MARKER }, { id: 'gpt-5-mini' }],
      apiKey: MARKER, accessToken: MARKER, env: { OPENAI_API_KEY: MARKER },
      command: ['secret-launch', MARKER], launches: [{ argv: [MARKER] }],
      label: 'Codex team', health: { state: 'ready', detail: MARKER },
    },
    {
      id: 'codex-personal', engine: 'codex', accountId: 'team/shared',
      models: [{ id: 'gpt-5.1' }], client_secret: MARKER,
      lastKnownUsage: { token: MARKER },
    },
    {
      id: 'claude-team', engine: 'claude', accountId: 'team/shared',
      models: [{ id: 'sonnet-4.6' }], sshKey: MARKER,
    },
  ],
};

const AGENT_NODE = (id: string) => `agent:${encodeURIComponent(id)}`;
const ACCOUNT_NODE = (engine: string, account: string) => `engine-account:${engine}/${encodeURIComponent(account)}`;
const MODEL_NODE = (engine: string, model: string) => `model:${engine}/${encodeURIComponent(model)}`;
const PLANNER = AGENT_NODE('planner/lead');
const OPS = AGENT_NODE('ops:eu');
const REVIEWER = AGENT_NODE('reviewer');
const CODEX_ACCOUNT = ACCOUNT_NODE('codex', 'team/shared');
const CLAUDE_ACCOUNT = ACCOUNT_NODE('claude', 'team/shared');

let work: string;
let home: string;
let output: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function workSnapshot(): Map<string, string> {
  return new Map(readdirSync(work).map((name) => [name, fileHash(join(work, name))]));
}

/** Persist the day-one inputs and return the real registry projection. */
function publish(fleet: unknown, seats: unknown): RegistryGraph {
  writeFileSync(join(work, 'fleet-seed.json'), JSON.stringify(fleet));
  writeFileSync(join(work, 'seats.json'), JSON.stringify(seats));
  const graph = buildRegistryGraph(
    JSON.parse(readFileSync(join(work, 'fleet-seed.json'), 'utf8')),
    JSON.parse(readFileSync(join(work, 'seats.json'), 'utf8')),
  );
  // The store serves graph.v1 projections in the loader's persisted-seed
  // contract; the projection itself is the registry's output, JSON round-tripped.
  const seatInput = Array.isArray(seats) ? seats : (seats as { seats?: unknown })?.seats;
  const seatRows = Array.isArray(seatInput) ? seatInput.length : 0;
  const doc: FleetGraphSeedV1 = {
    v: 1,
    kind: FLEET_GRAPH_SEED_KIND,
    generatedAt: GENERATED_AT,
    complete: graph.complete,
    sources: {
      fleetJson: { state: 'loaded', path: join(work, 'fleet-seed.json') },
      seats: { state: 'loaded', count: seatRows },
    },
    nodes: JSON.parse(JSON.stringify(graph.nodes)),
    edges: JSON.parse(JSON.stringify(graph.edges)),
    issues: JSON.parse(JSON.stringify(graph.issues)),
    counts: { nodes: graph.nodes.length, edges: graph.edges.length, repos: 0, lanes: 0,
      seats: graph.nodes.filter((node) => node.kind === 'engine-account').length, holds: 0, rejected: 0 },
    limits: { maxNodes: FLEET_GRAPH_SEED_LIMITS.maxNodes, maxEdges: FLEET_GRAPH_SEED_LIMITS.maxEdges },
  };
  writeFileSync(join(work, 'graph-seed.json'), JSON.stringify(doc));
  reader.mockImplementation(async () =>
    JSON.parse(readFileSync(join(work, 'graph-seed.json'), 'utf8')) as FleetGraphSeedV1);
  return graph;
}

async function query(args: string[]): Promise<{ code: number; body: Record<string, unknown>; text: string }> {
  output.mockClear();
  const code = await cmdGraph([...args, '--json']);
  expect(output).toHaveBeenCalledOnce();
  const text = output.mock.calls[0]![0] as string;
  return { code, body: JSON.parse(text) as Record<string, unknown>, text };
}

async function ready(args: string[]): Promise<Record<string, unknown>> {
  const { code, body } = await query(args);
  expect(code).toBe(0);
  expect(errors).not.toHaveBeenCalled();
  expect(body).toMatchObject({ schemaVersion: 1, status: 'ready' });
  return body;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gri31aj3-home-'));
  work = mkdtempSync(join(tmpdir(), 'gri31aj3-work-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(GENERATED_AT));
  reader.mockReset();
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('day-one agent graph: fleet seed + public seats snapshot through phm graph', () => {
  it('projects stable identities and real routes-to endpoints end to end', async () => {
    const graph = publish(FLEET_SEED, SEATS_SNAPSHOT);
    expect(graph).toMatchObject({ schema: 'graph.v1', readOnly: true, complete: true,
      sources: { fleet: 'loaded', seats: 'loaded' }, issues: [] });
    const disk = workSnapshot();

    const status = await ready(['status']);
    expect(status).toMatchObject({ command: 'status', counts: { nodes: 10, edges: 12 },
      sources: { fleetJson: { state: 'loaded' }, seats: { state: 'loaded', count: 3 } } });

    const nodes = (await ready(['nodes']))['nodes'] as { id: string; kind: string }[];
    expect(nodes.map((node) => node.id)).toEqual([
      OPS, PLANNER, REVIEWER,
      CLAUDE_ACCOUNT, CODEX_ACCOUNT,
      'mcp:locus', 'mcp:phantom-secrets',
      MODEL_NODE('claude', 'sonnet-4.6'), MODEL_NODE('codex', 'gpt-5-mini'), MODEL_NODE('codex', 'gpt-5.1'),
    ]);
    expect(nodes).toEqual(graph.nodes);
    // The public surface only carries allowlisted identity fields.
    for (const node of nodes) {
      const keys = Object.keys(node).sort();
      if (node.kind === 'engine-account') expect(keys).toEqual(['accountId', 'engine', 'id', 'kind', 'seatIds']);
      else if (node.kind === 'model') expect(keys).toEqual(['engine', 'id', 'kind', 'modelId']);
      else if (node.kind === 'mcp') expect(keys).toEqual(['id', 'kind', 'serverId']);
      else expect(keys).toEqual(['agentId', 'id', 'kind']);
    }
    // Two seats on one engine+account merge into a single stable account node.
    const account = nodes.find((node) => node.id === CODEX_ACCOUNT)!;
    expect(account).toMatchObject({ kind: 'engine-account', engine: 'codex', accountId: 'team/shared',
      seatIds: ['codex-personal', 'codex-team'] });

    const edges = (await ready(['edges']))['edges'] as { id: string; kind: string; from: string; to: string; source: string }[];
    expect(edges).toEqual(graph.edges);
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const edge of edges) {
      expect(nodeIds.has(edge.from), `edge ${edge.id} has a real from endpoint`).toBe(true);
      expect(nodeIds.has(edge.to), `edge ${edge.id} has a real to endpoint`).toBe(true);
      expect(edge.id.startsWith(`${edge.kind}:`)).toBe(true);
      expect(Object.keys(edge).sort()).toEqual(['from', 'id', 'kind', 'source', 'to']);
    }
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'routes-to', from: PLANNER, to: CODEX_ACCOUNT, source: 'fleet' }),
      expect.objectContaining({ kind: 'routes-to', from: PLANNER, to: MODEL_NODE('codex', 'gpt-5.1'), source: 'fleet' }),
      expect.objectContaining({ kind: 'routes-to', from: PLANNER, to: 'mcp:locus', source: 'fleet' }),
      expect.objectContaining({ kind: 'routes-to', from: PLANNER, to: 'mcp:phantom-secrets', source: 'fleet' }),
      expect.objectContaining({ kind: 'routes-to', from: OPS, to: CLAUDE_ACCOUNT, source: 'fleet' }),
      expect.objectContaining({ kind: 'routes-to', from: OPS, to: MODEL_NODE('claude', 'sonnet-4.6'), source: 'fleet' }),
      expect.objectContaining({ kind: 'routes-to', from: CODEX_ACCOUNT, to: MODEL_NODE('codex', 'gpt-5-mini'), source: 'seats' }),
      expect.objectContaining({ kind: 'routes-to', from: CLAUDE_ACCOUNT, to: MODEL_NODE('claude', 'sonnet-4.6'), source: 'seats' }),
      expect.objectContaining({ kind: 'can-delegate', from: PLANNER, to: OPS, source: 'fleet' }),
      expect.objectContaining({ kind: 'can-message', from: OPS, to: PLANNER, source: 'fleet' }),
      expect.objectContaining({ kind: 'reviews', from: REVIEWER, to: PLANNER, source: 'fleet' }),
    ]));
    // The unbound agent is an identity node with no routes-to bindings.
    expect(edges.filter((edge) => edge.kind === 'routes-to' && edge.from === REVIEWER)).toEqual([]);

    // Encoded identities round-trip through the exact-node query.
    const planner = await ready(['node', PLANNER]);
    expect(planner).toMatchObject({ command: 'node', node: { id: PLANNER, kind: 'agent', agentId: 'planner/lead' } });

    expect(errors).not.toHaveBeenCalled();
    expect(workSnapshot()).toEqual(disk);
    expect(existsSync(join(home, '.ashlr'))).toBe(false);
  });

  it('answers the public filters over the same projection', async () => {
    publish(FLEET_SEED, SEATS_SNAPSHOT);
    const disk = workSnapshot();

    const routes = (await ready(['edges', '--kind', 'routes-to']))['edges'] as { kind: string }[];
    expect(routes).toHaveLength(9);
    expect(routes.every((edge) => edge.kind === 'routes-to')).toBe(true);
    expect(((await ready(['nodes', '--kind', 'agent']))['nodes'] as unknown[]).length).toBe(3);
    expect(((await ready(['nodes', '--kind', 'engine-account']))['nodes'] as unknown[]).length).toBe(2);
    expect(((await ready(['nodes', '--kind', 'model']))['nodes'] as unknown[]).length).toBe(3);
    expect(((await ready(['nodes', '--kind', 'mcp']))['nodes'] as unknown[]).length).toBe(2);

    // --agent resolves a bare id to the agent plus its direct routes-to targets.
    const bound = (await ready(['nodes', '--agent', 'planner/lead']))['nodes'] as { id: string }[];
    expect(bound.map((node) => node.id).sort()).toEqual([
      PLANNER, CODEX_ACCOUNT, MODEL_NODE('codex', 'gpt-5.1'), 'mcp:locus', 'mcp:phantom-secrets',
    ].sort());
    const incident = (await ready(['edges', '--agent', 'planner/lead']))['edges'] as { from: string; to: string }[];
    expect(incident).toHaveLength(7);
    expect(incident.every((edge) => edge.from === PLANNER || edge.to === PLANNER)).toBe(true);
    const mcpOnly = (await ready(['nodes', '--agent', 'planner/lead', '--kind', 'mcp']))['nodes'] as { id: string }[];
    expect(mcpOnly.map((node) => node.id)).toEqual(['mcp:locus', 'mcp:phantom-secrets']);

    const fromOps = (await ready(['edges', '--from', OPS]))['edges'] as { kind: string; to: string }[];
    expect(fromOps.map((edge) => edge.to).sort()).toEqual([CLAUDE_ACCOUNT, MODEL_NODE('claude', 'sonnet-4.6'), PLANNER].sort());
    const toLocus = (await ready(['edges', '--to', 'mcp:locus']))['edges'] as { from: string }[];
    expect(toLocus).toEqual([expect.objectContaining({ from: PLANNER })]);

    // Bounded neighborhoods traverse the same edges in both directions.
    const out = await ready(['neighbors', PLANNER, '--direction', 'out']);
    expect(out).toMatchObject({ nodeId: PLANNER, direction: 'out', depth: 1, truncated: false });
    expect((out['nodes'] as { id: string }[]).map((node) => node.id).sort()).toEqual(
      [PLANNER, OPS, CODEX_ACCOUNT, MODEL_NODE('codex', 'gpt-5.1'), 'mcp:locus', 'mcp:phantom-secrets'].sort());
    // Induced subgraph: the six planner-incident edges plus the account→model seats edge.
    expect((out['edges'] as unknown[]).length).toBe(7);
    expect(out['traversal']).toEqual(expect.arrayContaining([
      { id: PLANNER, distance: 0, predecessor: null },
      expect.objectContaining({ id: CODEX_ACCOUNT, distance: 1, predecessor: PLANNER }),
    ]));

    const inbound = await ready(['neighbors', PLANNER, '--direction', 'in']);
    expect((inbound['nodes'] as { id: string }[]).map((node) => node.id).sort()).toEqual([OPS, PLANNER, REVIEWER].sort());
    expect((inbound['edges'] as unknown[]).length).toBe(3);

    const routed = await ready(['neighbors', PLANNER, '--edge-kind', 'routes-to']);
    expect((routed['nodes'] as { id: string }[]).map((node) => node.id).sort()).toEqual(
      [PLANNER, CODEX_ACCOUNT, MODEL_NODE('codex', 'gpt-5.1'), 'mcp:locus', 'mcp:phantom-secrets'].sort());
    expect((routed['edges'] as { kind: string }[]).every((edge) => edge.kind === 'routes-to')).toBe(true);

    // Missing identities are explicit, never fabricated.
    for (const args of [['node', 'agent:ghost'], ['neighbors', 'agent:ghost'],
      ['nodes', '--agent', 'ghost'], ['edges', '--agent', 'ghost']]) {
      const { code, body } = await query(args);
      expect(code).toBe(1);
      expect(body).toMatchObject({ status: 'not_found', error: { code: 'GRAPH_NODE_NOT_FOUND' } });
    }
    reader.mockClear();
    const usage = await query(['nodes', '--kind', 'bogus']);
    expect(usage.code).toBe(2);
    expect(usage.body).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
    expect(reader).not.toHaveBeenCalled();

    output.mockClear();
    expect(await cmdGraph(['--help'])).toBe(0);
    expect(reader).not.toHaveBeenCalled();

    expect(workSnapshot()).toEqual(disk);
  });

  it('reports partial-source issues while still serving surviving records', async () => {
    const graph = publish({
      schema: 'fleet.v1',
      agents: [
        { id: 'bound', seatId: 'codex-team', modelId: 'nope-model', mcpIds: ['nope-mcp'] },
        { id: 'adrift', seatId: 'ghost-seat' },
      ],
      mcp: [{ id: 'locus' }],
      edges: [{ kind: 'reviews', from: 'bound', to: 'missing-agent' }],
    }, SEATS_SNAPSHOT);
    expect(graph).toMatchObject({ complete: false, sources: { fleet: 'loaded', seats: 'loaded' },
      issues: [
        { source: 'fleet', code: 'unknown-agent' },
        { source: 'fleet', code: 'unknown-mcp' },
        { source: 'fleet', code: 'unknown-model' },
        { source: 'fleet', code: 'unknown-seat' },
      ] });

    const nodesBody = await ready(['nodes']);
    expect(nodesBody).toMatchObject({ complete: false, issues: graph.issues });
    const nodes = nodesBody['nodes'] as { id: string; kind: string }[];
    const nodeIds = new Set(nodes.map((node) => node.id));
    expect(nodeIds).toContain(CODEX_ACCOUNT);
    expect(nodeIds).toContain(AGENT_NODE('bound'));
    // Unknown references produce issues, never phantom endpoints.
    expect([...nodeIds].some((id) => id.includes('ghost-seat') || id.includes('missing-agent')
      || id.includes('nope-model') || id.includes('nope-mcp'))).toBe(false);
    const edges = (await ready(['edges']))['edges'] as { from: string; to: string }[];
    for (const edge of edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
    // The mismatched agent keeps its resolvable account binding but no model/mcp route.
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'routes-to', from: AGENT_NODE('bound'), to: CODEX_ACCOUNT }),
    ]));
    expect(edges.filter((edge) => edge.from === AGENT_NODE('adrift')
      || (edge.from === AGENT_NODE('bound') && (edge.to.startsWith('model:') || edge.to.startsWith('mcp:'))))).toEqual([]);
  });

  it('marks a rejected seats source invalid and keeps fleet evidence only', async () => {
    const graph = publish(FLEET_SEED, [
      { id: 'dup', engine: 'codex', accountId: 'team/shared', models: [] },
      { id: 'dup', engine: 'codex', accountId: 'team/shared', models: [] },
    ]);
    expect(graph).toMatchObject({ complete: false,
      sources: { fleet: 'loaded', seats: 'invalid' },
      issues: expect.arrayContaining([{ source: 'seats', code: 'invalid' }]) });
    expect(graph.issues).toContainEqual({ source: 'fleet', code: 'unknown-seat' });

    const nodes = (await ready(['nodes']))['nodes'] as { kind: string }[];
    expect(nodes).toHaveLength(5);
    expect(nodes.every((node) => node.kind === 'agent' || node.kind === 'mcp')).toBe(true);
    const edges = (await ready(['edges']))['edges'] as { kind: string; source: string }[];
    expect(edges.every((edge) => edge.source === 'fleet')).toBe(true);
    // Agent-to-MCP bindings survive even when the seat catalog was rejected.
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'routes-to', from: PLANNER, to: 'mcp:locus' }),
    ]));
  });

  it('withholds a wholly rejected projection but keeps a valid empty inventory ready', async () => {
    publish({ not: 'a fleet seed' }, { not: 'seats' });
    for (const args of [['status'], ['nodes'], ['edges'], ['node', 'agent:none'], ['neighbors', 'agent:none']]) {
      const { code, body } = await query(args);
      expect(code).toBe(1);
      expect(body).toMatchObject({ status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' } });
    }

    // A failing store read also degrades to unavailable, without diagnostics leaking.
    reader.mockRejectedValue(new Error('PRIVATE_STORE_DETAIL'));
    expect(await loadGraph()).toEqual({ status: 'unavailable' });
    const failed = await query(['status']);
    expect(failed.code).toBe(1);
    expect(failed.body).toMatchObject({ status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' } });
    expect(failed.text).not.toContain('PRIVATE_STORE_DETAIL');

    const empty = publish({ schema: 'fleet.v1', agents: [], mcp: [], edges: [] }, []);
    expect(empty).toMatchObject({ complete: true, nodes: [], edges: [], issues: [] });
    expect((await ready(['status']))['counts']).toEqual({ nodes: 0, edges: 0 });
    expect((await ready(['nodes']))['nodes']).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps fake credential metadata out of the projection and persists nothing extra', async () => {
    const graph = publish(FLEET_SEED, SEATS_SNAPSHOT);
    expect(JSON.stringify(graph)).not.toContain(MARKER);
    const disk = workSnapshot();
    const outputs: string[] = [];

    for (const args of [
      ['status'], ['nodes'], ['edges'],
      ['node', CODEX_ACCOUNT], ['neighbors', PLANNER], ['nodes', '--agent', 'planner/lead'],
    ]) {
      const { code, text } = await query(args);
      expect(code).toBe(0);
      outputs.push(text);
    }
    for (const text of outputs) {
      expect(text).not.toContain(MARKER);
      expect(JSON.parse(text)).not.toBeNull();
    }

    // A cold rebuild from the same persisted inputs reproduces the graph byte-for-byte.
    const rebuilt = buildRegistryGraph(
      JSON.parse(readFileSync(join(work, 'fleet-seed.json'), 'utf8')),
      JSON.parse(readFileSync(join(work, 'seats.json'), 'utf8')),
    );
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(graph));

    expect(workSnapshot()).toEqual(disk);
    expect(readdirSync(home)).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});
