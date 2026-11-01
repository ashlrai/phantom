/**
 * RQ-PHX-GRAPHREGISTRYAPIRECUT31 — recut coverage for the stranded PR #2259:
 * GET /api/verse/fleet/graph (src/core/verse/fleet-graph-api.ts) mounted on
 * the REAL verse-api router (src/core/verse/verse-api.ts, mount id
 * `fleet-graph`, after `fleet-holds`).
 *
 * Runs the real server (read-session boundary, handleApi dispatch, the real
 * DEFAULT_API_MODULES table — no swapped mounts) under a relocated HOME, so
 * the production `handleFleetGraphApi` singleton serves the fixture fleet
 * document written under the test's own ASHLR_HOME.
 *
 * What is proven here:
 *   - the `fleet-graph` mount exists on the real router and its loader
 *     resolves the production handler;
 *   - a missing registry is a STATE, not an error: 200 with an empty graph,
 *     `sources.fleet: 'missing'` and a matching issue;
 *   - a populated fleet.v1 seed projects agents, MCP servers and the
 *     declared relationship edges with `complete: true`;
 *   - only `live=1` is an accepted query — every other key or value is a
 *     400 VERSE_INVALID, and non-GET is a 405 once past the dispatch gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import {
  invalidateVerseSeatCache,
  mountedApiModules,
  resetVerseEngine,
  setMountedApiModulesForTest,
} from '../src/core/verse/verse-api.js';
import {
  handleFleetGraphApi,
  VERSE_FLEET_GRAPH_PATH as PATH,
  type FleetGraphResponseV1,
} from '../src/core/verse/fleet-graph-api.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

// ---------------------------------------------------------------------------
// Harness (mirrors test/verse-api-mount-310.test.ts)
// ---------------------------------------------------------------------------

const FLEET_SEED = {
  schema: 'fleet.v1',
  agents: [
    { id: 'planner/lead', mcpIds: ['locus'] },
    { id: 'reviewer' },
  ],
  mcp: [{ id: 'locus' }],
  edges: [{ kind: 'reviews', from: 'reviewer', to: 'planner/lead' }],
};

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    // Port 1 refuses immediately: no local seats, no 2s timeout wait.
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

/** Just enough engine for the V1 routes ahead of the modules: no sessions, never spawns. */
function emptyEngine(): VerseEngineHandle {
  return {
    listSessions: () => [],
    getSession: () => null,
    getEvents: () => [],
    subscribe: () => () => {},
    close: () => {},
  } as unknown as VerseEngineHandle;
}

interface HttpResult { status: number; body: string; json: unknown }

function request(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* not json (or HEAD) */ }
          resolve({ status: res.statusCode ?? 0, body: raw, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let tmpHome: string;
let prevHome: string | undefined;
let prevAshlrHome: string | undefined;
let cfg: AshlrConfig;
let handles: Array<{ close(): Promise<void> }> = [];

function fleetDocPath(): string {
  return path.join(tmpHome, 'fleet', 'fleet.json');
}

function writeFleetDoc(value: unknown): void {
  fs.mkdirSync(path.dirname(fleetDocPath()), { recursive: true });
  fs.writeFileSync(fleetDocPath(), JSON.stringify(value));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-fleet-graph-recut-'));
  prevHome = process.env.HOME;
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = tmpHome;
  // fleetInventoryPath() honours an absolute ASHLR_HOME; the production
  // handler resolves it per request, so the fixture lands here.
  process.env.ASHLR_HOME = tmpHome;
  const accountsRoot = path.join(tmpHome, '.ashlr', 'account-connections');
  fs.mkdirSync(accountsRoot, { recursive: true });
  fs.writeFileSync(path.join(accountsRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
  cfg = makeConfig(accountsRoot);
  resetVerseEngine(emptyEngine());
  invalidateVerseSeatCache();
  // The real mount table: this test exists to prove the production mount.
  setMountedApiModulesForTest(null);
  handles = [];
});

afterEach(async () => {
  for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
  handles = [];
  setMountedApiModulesForTest(null);
  resetVerseEngine(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function boot(opts: Partial<WebServerOptions> = {}) {
  const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: true, ...opts });
  handles.push(handle);
  const read = readAuthHeaders(handle.port);
  const mutate = { 'x-ashlr-token': handle.token, 'content-type': 'application/json' };
  return { port: handle.port, read, mutate };
}

// ---------------------------------------------------------------------------
// The mount itself
// ---------------------------------------------------------------------------

describe('the fleet-graph mount on the real verse-api router', () => {
  it('is the last entry of the real mount table and resolves to the production handler', async () => {
    const modules = mountedApiModules();
    expect(modules[modules.length - 1]?.id).toBe('fleet-graph');
    const entry = modules.find((m) => m.id === 'fleet-graph');
    expect(entry).toBeDefined();
    expect(await entry!.load()).toBe(handleFleetGraphApi);
  });

  it('GET returns an empty graph with sources.fleet "missing" when no registry inputs exist', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', PATH, read);
    expect(res.status).toBe(200);
    const body = res.json as FleetGraphResponseV1;
    expect(body.v).toBe(1);
    expect(typeof body.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.live).toBeUndefined();
    expect(body.graph).toMatchObject({
      schema: 'graph.v1',
      readOnly: true,
      complete: false,
      sources: { fleet: 'missing', seats: 'loaded' },
      nodes: [],
      edges: [],
    });
    expect(body.graph.issues).toContainEqual({ source: 'fleet', code: 'missing' });
    expect(body.sources).toEqual({ fleet: 'missing', seats: 'loaded' });
  });

  it('GET returns the populated registry projection for a fleet.v1 seed', async () => {
    writeFleetDoc(FLEET_SEED);
    const { port, read } = await boot();
    const res = await request(port, 'GET', PATH, read);
    expect(res.status).toBe(200);
    const body = res.json as FleetGraphResponseV1;
    expect(body.graph).toMatchObject({ schema: 'graph.v1', readOnly: true, complete: true });
    expect(body.graph.issues).toEqual([]);
    expect(body.sources).toEqual({ fleet: 'loaded', seats: 'loaded' });
    const ids = body.graph.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining([
      `agent:${encodeURIComponent('planner/lead')}`,
      'agent:reviewer',
      'mcp:locus',
    ]));
    expect(body.graph.edges).toContainEqual(expect.objectContaining({
      kind: 'reviews', from: 'agent:reviewer', to: `agent:${encodeURIComponent('planner/lead')}`, source: 'fleet',
    }));
    expect(body.graph.edges).toContainEqual(expect.objectContaining({
      kind: 'routes-to', from: `agent:${encodeURIComponent('planner/lead')}`, to: 'mcp:locus', source: 'fleet',
    }));
  });

  it('rejects every query key and value except live=1 with 400 VERSE_INVALID', async () => {
    const { port, read } = await boot();
    for (const url of [`${PATH}?bogus=1`, `${PATH}?live=2`, `${PATH}?live`, `${PATH}?live=1&extra=1`]) {
      const res = await request(port, 'GET', url, read);
      expect(res.status, url).toBe(400);
      expect(res.json, url).toMatchObject({ code: 'VERSE_INVALID' });
    }
    const live = await request(port, 'GET', `${PATH}?live=1`, read);
    expect(live.status).toBe(200);
    expect((live.json as FleetGraphResponseV1).live).toMatchObject({ schema: 'graph-live.v1', readOnly: true });
  });

  it('non-GET methods that pass the mutation gate are 405 from the module', async () => {
    const { port, mutate } = await boot();
    const res = await request(port, 'POST', PATH, mutate, '{}');
    expect(res.status).toBe(405);
  });
});
