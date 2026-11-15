import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildNodesSnapshot, NODE_DOWN_MS, NODE_STALE_MS } from '../src/core/nodes/view.js';

/**
 * nodes-view-deskfix — coverage for the RQ-PHX-REDDESKFIXC169 landing of #5103.
 *
 * The PR wired GET /api/nodes to buildNodesSnapshot, which pulled
 * src/core/nodes/view.ts (and its drive/nodes imports) into the Tier-1
 * authority import closure; CI's Quick typecheck authority-drift shard failed
 * until the reviewed closure snapshot was regenerated. These tests pin both
 * the reviewed growth and the snapshot contract the panel consumes.
 */
const NOW = 1_800_000_000_000;

function inventory(over: Record<string, unknown> = {}) {
  return {
    version: 'drive.nodes.v1',
    sequence: 5,
    observedAt: NOW - 1_000,
    nodes: [
      { nodeId: 'alpha', session: 2, heartbeatAt: NOW - 30_000, expiresAt: NOW + 60_000, owners: ['zeta', 'mason'], caps: ['gh', 'os:darwin'], auth: 'ok' },
      { nodeId: 'beta', session: 3, heartbeatAt: NOW - (NODE_STALE_MS + 30_000), expiresAt: NOW + 60_000, auth: 'missing' },
      { nodeId: 'gamma', session: 4, heartbeatAt: NOW - (NODE_DOWN_MS + 10_000), expiresAt: NOW - 10_000 },
    ],
    leader: { nodeId: 'alpha', session: 2, token: 3, expiresAt: NOW + 60_000 },
    jobs: [
      { id: 'RQ-9', state: 'pending' },
      { id: 'RQ-7', state: 'running', claim: { jobId: 'RQ-7', nodeId: 'alpha', session: 2, token: 4, leaderToken: 3, expiresAt: NOW + 60_000 } },
      { id: 'RQ-5', state: 'completed', result: 'done', claim: { jobId: 'RQ-5', nodeId: 'beta', session: 3, token: 5, leaderToken: 2, expiresAt: NOW - 1_000 } },
    ],
    ...over,
  };
}

describe('buildNodesSnapshot (phantom.nodes.v1)', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nodes-view-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function write(value: unknown): void {
    writeFileSync(join(dir, 'nodes.json'), typeof value === 'string' ? value : JSON.stringify(value));
  }

  it('reports a missing inventory without throwing', () => {
    const snap = buildNodesSnapshot({ dir, nowMs: NOW });
    expect(snap.schema).toBe('phantom.nodes.v1');
    expect(snap.nodes).toEqual([]);
    expect(snap.leaderId).toBeNull();
    expect(snap.error).toBe('inventory missing');
  });

  it('maps status, role, sorted owners/caps, live jobs and resolves the live leader lease', () => {
    write(inventory());
    const snap = buildNodesSnapshot({ dir, nowMs: NOW });
    expect(snap.error).toBeNull();
    expect(snap.leaderId).toBe('alpha');
    expect(snap.observedAt).toBe(new Date(NOW - 1_000).toISOString());
    expect(snap.nodes.map(n => n.id)).toEqual(['alpha', 'beta', 'gamma']);
    const [alpha, beta, gamma] = snap.nodes;
    expect(alpha).toMatchObject({ role: 'leader', status: 'ready', leader: true, owners: ['mason', 'zeta'], caps: ['gh', 'os:darwin'], heartbeatAgeMs: 30_000, liveJobs: ['RQ-7'], ghAuth: 'ok', source: 'registry' });
    expect(beta).toMatchObject({ role: 'worker', status: 'stale', leader: false, ghAuth: 'missing', liveJobs: [] });
    expect(gamma).toMatchObject({ role: 'worker', status: 'down', ghAuth: 'unknown' });
  });

  it('drops the whole snapshot to an error when any field holds a secret-shaped value', () => {
    write(inventory({ nodes: [{ nodeId: 'leak', session: 1, heartbeatAt: NOW - 1_000, expiresAt: NOW + 1_000, owners: [`ghp_${'a'.repeat(20)}`] }] }));
    const snap = buildNodesSnapshot({ dir, nowMs: NOW });
    expect(snap.nodes).toEqual([]);
    expect(snap.error).toBe('inventory contains a secret-shaped value');
  });

  it('rejects corrupt inventories distinctly', () => {
    write('not json {');
    expect(buildNodesSnapshot({ dir, nowMs: NOW }).error).toBe('inventory is not valid JSON');
    write({ version: 'drive.nodes.v1', sequence: 'x' });
    expect(buildNodesSnapshot({ dir, nowMs: NOW }).error).toBe('inventory failed validation');
  });
});

describe('the /api/nodes wiring (the change that grew the Tier-1 closure)', () => {
  it('serves buildNodesSnapshot from the web API', () => {
    const api = readFileSync('src/core/web/api.ts', 'utf8');
    expect(api).toContain("import { buildNodesSnapshot } from '../nodes/view.js';");
    expect(api).toContain("path === '/api/nodes' && method === 'GET'");
  });

  it('records the reviewed closure growth in the authority snapshot', () => {
    const closure = JSON.parse(readFileSync(resolve('test/fixtures/authority/tier1-closure.json'), 'utf8')) as { closure: string[] };
    for (const path of ['src/core/nodes/view.ts', 'src/core/drive/nodes/state.ts', 'src/core/drive/nodes/router.ts']) {
      expect(closure.closure, `${path} must be a recorded Tier-1 member`).toContain(path);
    }
  });
});
