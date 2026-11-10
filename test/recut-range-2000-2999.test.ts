// Recut of #2880 (RQ-NODE-4-VIEW): the fleet nodes web surface.
// `ashlr fleet nodes` already landed on master; the missing half was
// GET /api/nodes serving the same phantom.nodes.v1 projection to the
// fleet dashboard's NodesPanel. These tests drive the real handleApi route.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { NODES_SCHEMA } from '../src/core/nodes/view.js';
import { handleApi } from '../src/core/web/api.js';

const socket = { localAddress: '127.0.0.1', localPort: 4312 };

afterEach(() => vi.unstubAllEnvs());

function nodesDir(): string {
  const home = mkdtempSync(join(tmpdir(), 'recut-2880-'));
  vi.stubEnv('ASHLR_HOME', home);
  const dir = join(home, 'nodes');
  mkdirSync(dir);
  return dir;
}

function response() {
  let status = 0;
  let body = '';
  const headers: Record<string, unknown> = {};
  const res = {
    writeHead: (code: number, values: Record<string, unknown>) => { status = code; Object.assign(headers, values); },
    end: (value: string) => { body = value; },
    setHeader: (name: string, value: unknown) => { headers[name] = value; },
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, headers, raw: body, body: JSON.parse(body) as Record<string, unknown> }) };
}

async function get(path: string, method = 'GET') {
  const req = { url: path, method, socket, headers: {} } as unknown as IncomingMessage;
  const out = response();
  const handled = await handleApi(req, out.res, defaultConfig(), { token: 'test-only', allowDispatch: false });
  return { handled, ...out.result() };
}

describe('GET /api/nodes (recut of #2880)', () => {
  it('serves the phantom.nodes.v1 projection with leader, roles, heartbeat age and live jobs', async () => {
    const dir = nodesDir();
    const now = Date.now();
    const nodes = [
      { nodeId: 'mac-mini-1', session: 1, heartbeatAt: now - 5_000, expiresAt: now + 600_000, caps: ['os:darwin', 'gh'], auth: 'ok' },
      { nodeId: 'lima-vm-2', session: 2, heartbeatAt: now - 120_000, expiresAt: now + 600_000 },
    ];
    const jobs = [
      { id: 'job-7', state: 'running', claim: { jobId: 'job-7', nodeId: 'mac-mini-1', session: 1, token: 3, leaderToken: 2, expiresAt: now + 600_000 } },
    ];
    writeFileSync(join(dir, 'nodes.json'), JSON.stringify({
      version: 'drive.nodes.v1', sequence: 3, observedAt: now, nodes, jobs,
      leader: { nodeId: 'mac-mini-1', session: 1, token: 2, expiresAt: now + 600_000 },
    }));

    const out = await get('/api/nodes');
    expect(out.handled).toBe(true);
    expect(out.status).toBe(200);
    expect(out.headers['Cache-Control']).toBe('no-store');
    expect(out.body).toMatchObject({ schema: NODES_SCHEMA, leaderId: 'mac-mini-1', error: null });
    const rows = out.body['nodes'] as Array<Record<string, unknown>>;
    expect(rows.map(n => [n['id'], n['role'], n['status'], n['leader'], (n['liveJobs'] as string[]).length])).toEqual([
      ['lima-vm-2', 'worker', 'stale', false, 0],
      ['mac-mini-1', 'leader', 'ready', true, 1],
    ]);
    expect(rows[1]).toMatchObject({ caps: ['gh', 'os:darwin'], ghAuth: 'ok' });
    // Read-only: the route never writes to the inventory directory.
    expect(readdirSync(dir)).toEqual(['nodes.json']);
  });

  it('reports a missing inventory as a 200 with an error field, not a failure', async () => {
    nodesDir();
    const out = await get('/api/nodes');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ schema: NODES_SCHEMA, nodes: [], leaderId: null, error: 'inventory missing' });
  });

  it('refuses an inventory holding a token-shaped value without echoing it', async () => {
    const dir = nodesDir();
    const fake = 'ghp_' + 'FAKEfake0123456789'.repeat(2);
    writeFileSync(join(dir, 'nodes.json'), JSON.stringify({
      version: 'drive.nodes.v1', sequence: 1, observedAt: 1, leader: null, jobs: [],
      nodes: [{ nodeId: 'leaky', session: 1, heartbeatAt: 1, expiresAt: 2, caps: [fake] }],
    }));
    const out = await get('/api/nodes');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ nodes: [], error: 'inventory contains a secret-shaped value' });
    expect(out.raw).not.toContain(fake);
  });

  it('does not answer a mutation on the read-only route', async () => {
    nodesDir();
    const out = await get('/api/nodes', 'POST');
    expect(out.status).toBe(404);
    expect(out.body['schema']).toBeUndefined();
  });
});
