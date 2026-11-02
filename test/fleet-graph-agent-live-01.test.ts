import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { joinGraphLive, type GraphLiveSources } from '../src/core/fleet/graph-live.js';
import { HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from '../src/core/routing/headroom.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetGraphLiveApi, VERSE_FLEET_GRAPH_LIVE_PATH as PATH, type FleetGraphLiveResponseV1 } from '../src/core/verse/fleet-graph-live-api.js';
import { resetVerseEngine, setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const NOW = Date.parse('2026-10-31T00:33:00Z');
const SECRET = 'fake-private-value-01';
const fleet = {
  schema: 'fleet.v1',
  agents: [
    { id: 'lead/one', seatId: 'one', modelId: 'm1', mcpIds: ['tool'], command: SECRET },
    { id: 'lead', seatId: 'two', modelId: 'm2' },
    { id: 'unbound', seatId: 'absent' },
  ],
  mcp: [{ id: 'tool', env: { KEY: SECRET } }],
  edges: [{ kind: 'reviews', from: 'lead/one', to: 'lead' }],
};
const seats = [
  { id: 'one', engine: 'grok', accountId: 'account-one', models: [{ id: 'm1' }], command: SECRET, env: { KEY: SECRET } },
  { id: 'two', engine: 'grok', accountId: 'account-two', models: [{ id: 'm2' }], accessToken: SECRET },
];
function seat(seatId: string, partial: Partial<SeatCapacity> = {}): SeatCapacity {
  return { seatId, engine: 'grok', label: seatId, free: false, signedOut: false, reachable: true,
    contextWindow: null, observedAt: new Date(NOW - 60_000).toISOString(), spentTodayUsd: 1.25,
    windows: [{ id: 'billing', usedPercent: 35, resetsAt: null, resetDescription: null, limitReached: false }],
    ...partial };
}
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-live-')); writeFileSync(join(dir, 'fleet.json'), JSON.stringify(fleet)); });
afterEach(() => { setMountedApiModulesForTest(null); resetVerseEngine(null); rmSync(dir, { recursive: true, force: true }); });

function api(evidence: GraphLiveSources = { seats: [seat('one'), seat('two')], quota: { events: [] } }, partial = false) {
  return createFleetGraphLiveApi({ fleetPath: join(dir, 'fleet.json'),
    ...(partial ? { seatsPath: join(dir, 'missing-seats.json') } : { listSeats: () => seats }),
    now: () => NOW, readLive: (graph, options) => joinGraphLive(graph, evidence, { nowMs: options.nowMs }) });
}
async function call(url: string, handler = api()) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method: 'GET', url, headers: {} }); req.end();
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { text = chunk ?? ''; return this; } } as unknown as ServerResponse;
  await handler({ cfg: {}, token: 'fake', allowDispatch: false } as VerseApiContext, req, res, PATH, 'GET');
  return { status, text, body: JSON.parse(text) as FleetGraphLiveResponseV1 };
}
const query = (id: string) => `${PATH}?agent=${encodeURIComponent(id)}`;

describe('agent-scoped fleet graph live', () => {
  it('returns exact metadata identity and direct bindings using the same complete live join', async () => {
    const full = await call(PATH);
    const scoped = await call(query('lead/one'));
    expect(full.status).toBe(200);
    expect(Object.keys(full.body).sort()).toEqual(['generatedAt', 'live', 'sources', 'v']);
    expect(full.body.live.nodes.some(node => node.kind === 'agent' && node.agentId === 'lead')).toBe(true);
    expect(scoped.status).toBe(200);
    expect(scoped.body.scope).toEqual({ kind: 'agent', agentId: 'lead/one' });
    expect(scoped.body.live.nodes.map(node => node.id)).toEqual([
      'agent:lead%2Fone', 'engine-account:grok/account-one', 'mcp:tool', 'model:grok/m1',
    ]);
    expect(scoped.body.edges?.map(edge => [edge.kind, edge.from, edge.to])).toEqual([
      ['routes-to', 'agent:lead%2Fone', 'engine-account:grok/account-one'],
      ['routes-to', 'agent:lead%2Fone', 'mcp:tool'],
      ['routes-to', 'agent:lead%2Fone', 'model:grok/m1'],
    ]);
    for (const node of scoped.body.live.nodes) expect(node).toEqual(full.body.live.nodes.find(item => item.id === node.id));
    expect(scoped.body.live.nodes.find(node => node.kind === 'agent')?.live).toMatchObject({ state: 'ready', usedPercent: 35, spentTodayUsd: 1.25 });
    expect(scoped.body.live.counts.nodes).toBe(4);
    expect(Object.values(scoped.body.live.counts.byState).reduce((a, b) => a + b, 0)).toBe(4);
    expect(scoped.body.live.complete).toBe(full.body.live.complete);
    expect(scoped.body.live.issues).toEqual(full.body.live.issues);
    expect(scoped.body.sources).toEqual(full.body.sources);
    expect(scoped.body.generatedAt).toBe(full.body.generatedAt);
    expect(scoped.text).not.toContain(SECRET);
    const other = await call(query('lead'));
    expect(other.body.live.nodes.map(node => node.id)).toEqual(['agent:lead', 'engine-account:grok/account-two', 'model:grok/m2']);
  });

  it('preserves held, stale and unknown observations independently of other seats', async () => {
    for (const [evidence, state] of [
      [seat('one', { signedOut: true }), 'held'],
      [seat('one', { observedAt: new Date(NOW - HEADROOM_READING_MAX_AGE_MS - 1).toISOString() }), 'stale'],
      [seat('one', { windows: [], observedAt: null }), 'unknown'],
    ] as const) {
      const result = await call(query('lead/one'), api({ seats: [evidence, seat('two')], quota: { events: [] } }));
      const agent = result.body.live.nodes.find(node => node.kind === 'agent');
      expect(agent?.live.state).toBe(state);
      expect(agent?.live.usedPercent).toBeNull();
      expect(result.body.live.nodes.find(node => node.kind === 'engine-account')?.live.state).toBe(state);
    }
  });

  it('keeps missing bindings and partial inventory incomplete without inventing resources', async () => {
    const unbound = await call(query('unbound'));
    expect(unbound.body.live.nodes).toHaveLength(1);
    expect(unbound.body.live.nodes[0]?.live).toMatchObject({ state: 'untracked', usedPercent: null });
    expect(unbound.body.edges).toEqual([]);
    expect(unbound.body.live.complete).toBe(false);
    const partial = await call(query('lead/one'), api({ seats: null, quota: null }, true));
    expect(partial.status).toBe(200);
    expect(partial.body.sources).toEqual({ fleet: 'loaded', seats: 'missing' });
    expect(partial.body.live.complete).toBe(false);
    expect(partial.body.live.issues).toContainEqual(expect.objectContaining({ code: 'graph-incomplete' }));
    expect(partial.body.live.nodes.map(node => node.id)).toEqual(['agent:lead%2Fone', 'mcp:tool']);
  });

  it('rejects absent identities and invalid, duplicate or unknown query parameters', async () => {
    for (const url of [query('missing'), query('agent:lead'), query('LEAD'), query('lead/one/extra')]) {
      expect((await call(url)).status).toBe(404);
    }
    for (const suffix of ['?agent=', '?agent=%20', '?agent=a&agent=b', '?agent=a&other=b', '?other=a', `?agent=${'a'.repeat(257)}`, '?agent=bad%20id']) {
      expect((await call(PATH + suffix)).status).toBe(400);
    }
  });

  it('enforces the existing HTTP read-session and dispatch boundary before the mounted handler', async () => {
    let reads = 0;
    const handler = createFleetGraphLiveApi({ fleetPath: join(dir, 'fleet.json'), listSeats: () => { reads++; return seats; },
      now: () => NOW, readLive: (graph, options) => joinGraphLive(graph, { seats: [seat('one'), seat('two')] }, { nowMs: options.nowMs }) });
    setMountedApiModulesForTest([{ id: 'fleet-graph-live', load: async () => handler }]);
    const cfg = { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
      models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
      telemetry: {}, tools: {}, verse: { accountsRoot: join(dir, 'accounts') } } as unknown as AshlrConfig;
    const server = await startServer(cfg, { port: 0, open: false, allowDispatch: false });
    const get = (method: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.port, path: query('lead/one'), method,
        headers: { Host: `127.0.0.1:${server.port}`, ...headers } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject); req.end();
    });
    try {
      expect(await get('GET')).toBe(401);
      expect(reads).toBe(0);
      expect(await get('POST', readAuthHeaders(server.port))).toBe(404);
      expect(reads).toBe(0);
      expect(await get('GET', readAuthHeaders(server.port))).toBe(200);
      expect(reads).toBe(1);
    } finally { await server.close(); }
  }, 30_000);
});
