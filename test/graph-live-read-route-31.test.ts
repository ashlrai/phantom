/**
 * RQ-PHX-GRAPHLIVEREAD31: GET /api/verse/fleet/graph/live — the read-only
 * graph-live.v1 surface for agents.
 *
 * The route builds the graph.v1 registry from the same evidence the graph
 * pipeline reads (fleet.json + the public seat inventory), then joins the
 * live projection from fleet/graph-live.ts onto it. Covered here:
 *
 *   - a populated fixture: capacity, cost, quota and reset evidence joined
 *     per node, with seat credentials never reaching the wire;
 *   - an empty fleet root: missing inputs are states (missing /
 *     graph-incomplete), never a healthy empty-looking success;
 *   - a stale reading: an old observation reports `stale` with its age,
 *     not a fresh-looking number;
 *   - route hygiene: GET only, no query parameters, foreign paths declined;
 *   - reachability: the real server + real mount table answer the path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFleetGraphLiveApi,
  VERSE_FLEET_GRAPH_LIVE_PATH as PATH,
  type FleetGraphLiveApiDeps,
  type FleetGraphLiveResponseV1,
} from '../src/core/verse/fleet-graph-live-api.js';
import { joinGraphLive, readGraphLive } from '../src/core/fleet/graph-live.js';
import { HEADROOM_READING_MAX_AGE_MS, type CapacityWindow, type SeatCapacity } from '../src/core/routing/headroom.js';
import type { FleetBudget } from '../src/core/fleet/budget-view.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import {
  handleVerseApi,
  invalidateVerseSeatCache,
  resetVerseEngine,
  setMountedApiModulesForTest,
  type VerseApiContext,
} from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const NOW = Date.parse('2026-10-31T00:33:00.000Z');
const MARKER = 'fake-token-31';

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
const MODEL_NODE = 'model:grok/grok-4';
const AGENT_NODE = `agent:${encodeURIComponent('planner/lead')}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-live-route-31-'));
  writeFileSync(join(dir, 'fleet.json'), JSON.stringify(FLEET_SEED));
});
afterEach(() => {
  setMountedApiModulesForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

function deps(extra: FleetGraphLiveApiDeps = {}): FleetGraphLiveApiDeps {
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
  return { handled, status, text: payload, body: payload ? JSON.parse(payload) as FleetGraphLiveResponseV1 : null };
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

describe('GET /api/verse/fleet/graph/live', () => {
  it('returns the graph-live.v1 projection with live evidence joined onto registry nodes', async () => {
    const api = createFleetGraphLiveApi(deps({
      readLive: (graph, options) => readGraphLive(graph, {
        ...options,
        seats: [seat({
          seatId: 'grok-team', engine: 'grok', spentTodayUsd: 3.25,
          observedAt: new Date(NOW - 60_000).toISOString(),
          windows: [window({ usedPercent: 42, resetsAt: new Date(NOW + 3_600_000).toISOString() })],
        })],
        quota: { events: [] },
        budget: BUDGET,
      }),
    }));
    const result = await call(api);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      v: 1,
      generatedAt: new Date(NOW).toISOString(),
      sources: { fleet: 'loaded', seats: 'loaded' },
    });
    const live = result.body!.live;
    expect(live).toMatchObject({
      schema: 'graph-live.v1', readOnly: true, authority: 'observation-only',
      sampledAtMs: NOW, complete: true,
    });
    expect(live.nodes.length).toBeGreaterThan(0);
    const account = live.nodes.find((n) => n.id === ACCOUNT_NODE)!;
    expect(account).toMatchObject({ kind: 'engine-account', engine: 'grok', accountId: 'team/shared' });
    expect(account.live).toMatchObject({ state: 'ready', usedPercent: 42, spentTodayUsd: 3.25 });
    expect(account.live.resetsAtMs).toBe(NOW + 3_600_000);
    expect(account.live.stale).toBe(false);
    // The model and bound agent inherit the serving account's observation.
    expect(live.nodes.find((n) => n.id === MODEL_NODE)!.live.state).toBe('ready');
    expect(live.nodes.find((n) => n.id === AGENT_NODE)!.live.state).toBe('ready');
    // mcp nodes carry no live signal — untracked, never a fabricated number.
    const mcp = live.nodes.find((n) => n.kind === 'mcp')!;
    expect(mcp.live).toMatchObject({ state: 'untracked', usedPercent: null, spentTodayUsd: null });
    expect(live.counts.nodes).toBe(live.nodes.length);
    expect(Object.values(live.counts.byState).reduce((a, b) => a + b, 0)).toBe(live.nodes.length);
    expect(live.budget).toMatchObject({ dailyBudgetUsd: 50, spentTodayUsd: 3.25, capReached: false });
    // Seat credentials and launcher fields never reach the wire.
    expect(result.text).not.toContain(MARKER);
  });

  it('an empty fleet root is a degraded state, not a healthy empty success', async () => {
    const api = createFleetGraphLiveApi({
      fleetPath: join(dir, 'absent-fleet.json'),
      seatsPath: join(dir, 'absent-seats.json'),
      now: () => NOW,
      readLive: (graph, options) => readGraphLive(graph, { ...options, seats: null, quota: null }),
    });
    const result = await call(api);
    expect(result.status).toBe(200);
    expect(result.body?.sources).toEqual({ fleet: 'missing', seats: 'missing' });
    const live = result.body!.live;
    expect(live.schema).toBe('graph-live.v1');
    expect(live.complete).toBe(false);
    expect(live.issues).toContainEqual(expect.objectContaining({ code: 'graph-incomplete' }));
    // No nodes exist to observe: zero nodes is the truth, while every
    // per-node evidence field would have been null had there been any.
    expect(live.nodes).toEqual([]);
    expect(live.counts).toMatchObject({ nodes: 0 });
    expect(live.budget).toBeNull();
  });

  it('a stale reading reports stale with its age, never a fresh-looking number', async () => {
    const staleObservedAt = new Date(NOW - HEADROOM_READING_MAX_AGE_MS - 5 * 60_000).toISOString();
    const api = createFleetGraphLiveApi(deps({
      readLive: (graph, options) => joinGraphLive(graph, {
        seats: [seat({
          seatId: 'grok-team', engine: 'grok', spentTodayUsd: 3.25,
          observedAt: staleObservedAt,
          windows: [window({ usedPercent: 42, resetsAt: new Date(NOW + 3_600_000).toISOString() })],
        })],
        usage: {}, verdicts: {}, quota: null, cfg: null, budget: null,
      }, { nowMs: options.nowMs }),
    }));
    const result = await call(api);
    expect(result.status).toBe(200);
    const live = result.body!.live;
    const account = live.nodes.find((n) => n.id === ACCOUNT_NODE)!;
    expect(account.live.state).toBe('stale');
    expect(account.live.stale).toBe(true);
    // An aged-out reading is not a measurement: no fresh percent, but a real
    // age. The metered spend it last reported is still the truth about spend.
    expect(account.live.usedPercent).toBeNull();
    expect(account.live.spentTodayUsd).toBe(3.25);
    expect(account.live.readingAgeMs).toBe(NOW - Date.parse(staleObservedAt));
    expect(account.live.reasons.join(' ')).toMatch(/stale/);
    // The bound agent sees the same blocking observation, never "ready".
    expect(live.nodes.find((n) => n.id === AGENT_NODE)!.live.state).toBe('stale');
  });

  it('is read-only and takes no query parameters', async () => {
    const api = createFleetGraphLiveApi(deps());
    expect((await call(api, 'GET', `${PATH}?bogus=1`)).status).toBe(400);
    expect((await call(api, 'GET', `${PATH}?live=1`)).status).toBe(400);
    expect((await call(api, 'POST')).status).toBe(405);
    expect((await call(api, 'DELETE')).status).toBe(405);
    expect((await call(api, 'GET', '/api/verse/fleet/graph')).handled).toBe(false);
    expect((await call(api, 'GET', '/unrelated')).handled).toBe(false);
  });

  it('the real server reaches the mounted module through the dispatcher', async () => {
    setMountedApiModulesForTest([{ id: 'fleet-graph-live', load: async () => createFleetGraphLiveApi(deps()) }]);
    const req = new PassThrough() as IncomingMessage & PassThrough;
    Object.assign(req, { method: 'GET', url: PATH, headers: {} });
    req.end();
    let status = 0, payload = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(chunk?: string) { payload = chunk ?? ''; return this; },
    } as unknown as ServerResponse;
    const ctx = { token: 'fixture-token', allowDispatch: false, cfg: {} } as VerseApiContext;
    expect(await handleVerseApi(ctx, req, res, PATH, 'GET')).toBe(true);
    expect(status).toBe(200);
    const body = JSON.parse(payload) as FleetGraphLiveResponseV1;
    expect(body.live).toMatchObject({ schema: 'graph-live.v1' });
    expect(body.sources).toEqual({ fleet: 'loaded', seats: 'loaded' });
  });
});

// ---------------------------------------------------------------------------
// Reachability through the real HTTP server and the real mount table.
// ---------------------------------------------------------------------------

describe('the running server', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let cfg: AshlrConfig;
  let handle: { port: number; close(): Promise<void> } | null = null;

  function makeConfig(accountsRoot: string): AshlrConfig {
    return {
      version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {},
      tidyRules: [], keepers: [],
      // Port 1 refuses immediately: no local seats, no 2s timeout wait.
      models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
      telemetry: {}, tools: {},
      verse: { accountsRoot },
    } as unknown as AshlrConfig;
  }

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'graph-live-route-31-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const accountsRoot = join(tmpHome, '.ashlr', 'account-connections');
    mkdirSync(accountsRoot, { recursive: true });
    writeFileSync(join(accountsRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
    cfg = makeConfig(accountsRoot);
    invalidateVerseSeatCache();
    setMountedApiModulesForTest(null);
    handle = await startServer(cfg, { port: 0, open: false, allowDispatch: false });
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    resetVerseEngine(null);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function roundtrip(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
        (res) => {
          let raw = '';
          res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
  const get = (port: number, urlPath: string, headers: Record<string, string>) => roundtrip(port, 'GET', urlPath, headers);

  // The first request lazily loads every mounted module ahead of this one.
  it('GET /api/verse/fleet/graph/live answers graph-live.v1 behind the read boundary', { timeout: 30_000 }, async () => {
    const result = await get(handle!.port, PATH, readAuthHeaders(handle!.port));
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as FleetGraphLiveResponseV1;
    expect(body.v).toBe(1);
    expect(body.live).toMatchObject({ schema: 'graph-live.v1', readOnly: true, authority: 'observation-only' });
    // The temp HOME has no fleet inventory: missing evidence is a state, never zero.
    expect(body.sources.fleet).toBe('missing');
    expect(body.live.complete).toBe(false);
    expect(body.live.nodes).toEqual([]);
  });

  it('the route is a read: unauthenticated and mutation-verb requests cannot reach it', { timeout: 30_000 }, async () => {
    const unauthenticated = await get(handle!.port, PATH, {});
    expect(unauthenticated.status).toBe(401);
    // Dispatch is disabled on this server: a write verb is a 404, not a route.
    const posted = await roundtrip(handle!.port, 'POST', PATH,
      { ...readAuthHeaders(handle!.port), 'content-type': 'application/json' }, '{}');
    expect(posted.status).toBe(404);
  });
});
