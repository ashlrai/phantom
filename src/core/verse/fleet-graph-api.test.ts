import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createFleetGraphApi,
  VERSE_FLEET_GRAPH_PATH as PATH,
  type FleetGraphApiDeps,
  type FleetGraphResponseV1,
} from './fleet-graph-api.js';
import { readGraphLive } from '../fleet/graph-live.js';
import type { FleetBudget } from '../fleet/budget-view.js';
import type { CapacityWindow, SeatCapacity } from '../routing/headroom.js';
import type { ApiModule } from './api-modules.js';
import { handleVerseApi, setMountedApiModulesForTest, type VerseApiContext } from './verse-api.js';

const NOW = Date.parse('2026-10-31T00:33:00.000Z');
const MARKER = 'fake-token-123';

const FLEET_SEED = {
  schema: 'fleet.v1',
  agents: [
    { id: 'planner/lead', seatId: 'grok-team', modelId: 'grok-4', mcpIds: ['locus'] },
    { id: 'reviewer' },
  ],
  mcp: [{ id: 'locus' }],
  edges: [{ kind: 'reviews', from: 'reviewer', to: 'planner/lead' }],
};

/** Public seat rows carrying private launcher/credential halves that must never project. */
const SEAT_ROWS = [
  {
    id: 'grok-team', engine: 'grok', accountId: 'team/shared',
    models: [{ id: 'grok-4' }],
    apiKey: MARKER, accessToken: MARKER, client_secret: MARKER,
    env: { GROK_API_KEY: MARKER }, command: ['secret-launch', MARKER],
    launches: [{ argv: [MARKER] }], label: 'Grok team',
    health: { state: 'ready', detail: MARKER },
  },
];

const ACCOUNT_NODE = 'engine-account:grok/team%2Fshared';
const AGENT_NODE = `agent:${encodeURIComponent('planner/lead')}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-graph-api-'));
  await writeFile(join(dir, 'fleet.json'), JSON.stringify(FLEET_SEED));
});
afterEach(async () => {
  setMountedApiModulesForTest(null);
  await rm(dir, { recursive: true, force: true });
});

function deps(extra: FleetGraphApiDeps = {}): FleetGraphApiDeps {
  return { fleetPath: join(dir, 'fleet.json'), listSeats: () => SEAT_ROWS, now: () => NOW, ...extra };
}

async function call(module: ApiModule, method = 'GET', url = PATH) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: {} });
  req.end();
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: false, cfg: {} } as VerseApiContext;
  const handled = await module(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, text: payload, body: payload ? JSON.parse(payload) as FleetGraphResponseV1 : null };
}

function window(partial: Partial<CapacityWindow>): CapacityWindow {
  return { id: 'primary', usedPercent: null, resetsAt: null, resetDescription: null, limitReached: false, ...partial };
}
function seat(partial: Partial<SeatCapacity> & { seatId: string; engine: SeatCapacity['engine'] }): SeatCapacity {
  return { label: partial.seatId, free: false, windows: [], signedOut: false, reachable: true,
    contextWindow: null, observedAt: null, spentTodayUsd: null, ...partial };
}
const BUDGET: FleetBudget = { day: '2026-10-31', dailyBudgetUsd: 50, budgetSource: 'config',
  spentTodayUsd: 3.25, remainingUsd: 46.75, capReached: false, reasons: [] };

it('GET returns the registry projection only', async () => {
  const result = await call(createFleetGraphApi(deps()));
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    v: 1,
    generatedAt: new Date(NOW).toISOString(),
    graph: { schema: 'graph.v1', readOnly: true, complete: true },
    sources: { fleet: 'loaded', seats: 'loaded' },
  });
  expect(result.body?.live).toBeUndefined();
  const ids = result.body!.graph.nodes.map((n) => n.id);
  expect(ids).toEqual(expect.arrayContaining([AGENT_NODE, 'agent:reviewer', 'mcp:locus', ACCOUNT_NODE, 'model:grok/grok-4']));
  expect(result.body!.graph.edges.some((e) => e.kind === 'reviews' && e.from === 'agent:reviewer' && e.to === AGENT_NODE)).toBe(true);
});

it('GET ?live=1 joins per-node capacity and cost onto the registry nodes', async () => {
  const api = createFleetGraphApi(deps({
    readLive: (graph, options) => readGraphLive(graph, {
      ...options,
      seats: [seat({
        seatId: 'grok-team', engine: 'grok', spentTodayUsd: 3.25,
        observedAt: new Date(NOW - 60_000).toISOString(),
        windows: [window({ usedPercent: 42, resetsAt: new Date(NOW + 3_600_000).toISOString() })],
      })],
      budget: BUDGET,
    }),
  }));
  const result = await call(api, 'GET', `${PATH}?live=1`);
  expect(result.status).toBe(200);
  const live = result.body!.live!;
  expect(live).toMatchObject({ schema: 'graph-live.v1', readOnly: true, authority: 'observation-only', sampledAtMs: NOW });
  expect(live.nodes).toHaveLength(result.body!.graph.nodes.length);
  const account = live.nodes.find((n) => n.id === ACCOUNT_NODE)!;
  expect(account.live.usedPercent).toBe(42);
  expect(account.live.spentTodayUsd).toBe(3.25);
  expect(account.live.state).toBe('ready');
  for (const node of live.nodes) {
    expect(typeof node.live.state).toBe('string');
    expect(Array.isArray(node.live.reasons)).toBe(true);
  }
  expect(live.budget).toMatchObject({ dailyBudgetUsd: 50, capReached: false });
});

it('a missing seats file reports seats:missing with an issue, not an error', async () => {
  const result = await call(createFleetGraphApi(deps({ seatsPath: join(dir, 'seats.json') })));
  expect(result.status).toBe(200);
  expect(result.body?.sources).toEqual({ fleet: 'loaded', seats: 'missing' });
  expect(result.body?.graph.sources.seats).toBe('missing');
  expect(result.body?.graph.complete).toBe(false);
  expect(result.body?.graph.issues).toContainEqual({ source: 'seats', code: 'missing' });
  const ids = result.body!.graph.nodes.map((n) => n.id);
  expect(ids).toContain('agent:reviewer');
  expect(ids.some((id) => id.startsWith('engine-account:'))).toBe(false);
});

it('missing and malformed fleet inputs degrade to states, never to 500s', async () => {
  const missing = await call(createFleetGraphApi(deps({ fleetPath: join(dir, 'absent.json') })));
  expect(missing.status).toBe(200);
  expect(missing.body?.sources).toEqual({ fleet: 'missing', seats: 'loaded' });
  expect(missing.body?.graph.complete).toBe(false);
  expect(missing.body?.graph.nodes.some((n) => n.id === ACCOUNT_NODE)).toBe(true);
  await writeFile(join(dir, 'fleet.json'), '{oops');
  const malformed = await call(createFleetGraphApi(deps()));
  expect(malformed.status).toBe(200);
  expect(malformed.body?.sources).toEqual({ fleet: 'invalid', seats: 'loaded' });
});

it('rejects unknown query keys and non-1 live values with 400', async () => {
  const api = createFleetGraphApi(deps());
  for (const url of [`${PATH}?bogus=1`, `${PATH}?live=2`, `${PATH}?live`, `${PATH}?live=1&extra=1`]) {
    expect((await call(api, 'GET', url)).status, url).toBe(400);
  }
  expect((await call(api, 'GET', `${PATH}?live=1`)).status).toBe(200);
  expect((await call(api, 'POST')).status).toBe(405);
  expect((await call(api, 'GET', '/unrelated')).handled).toBe(false);
});

it('never projects seat credentials, launcher fields or labels', async () => {
  const result = await call(createFleetGraphApi(deps()), 'GET', `${PATH}?live=1`);
  expect(result.status).toBe(200);
  expect(result.text).not.toContain(MARKER);
});

it('the real server reaches the mounted module through the dispatcher', async () => {
  setMountedApiModulesForTest([{ id: 'fleet-graph', load: async () => createFleetGraphApi(deps()) }]);
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method: 'GET', url: `${PATH}?live=1`, headers: {} });
  req.end();
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: false, cfg: {} } as VerseApiContext;
  expect(await handleVerseApi(ctx, req, res, PATH, 'GET')).toBe(true);
  expect(status).toBe(200);
  expect(JSON.parse(payload)).toMatchObject({
    v: 1,
    graph: { schema: 'graph.v1' },
    live: { schema: 'graph-live.v1' },
    sources: { fleet: 'loaded', seats: 'loaded' },
  });
});
