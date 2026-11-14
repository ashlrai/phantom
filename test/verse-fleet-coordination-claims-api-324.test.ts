/** GET /api/verse/fleet/coordination-claims — read-only claims view. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_COORDINATION_CLAIMS_PATH as PATH,
  createFleetCoordinationClaimsApi,
} from '../src/core/verse/fleet-coordination-claims-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import { WORKBENCH_ROUTE_FAMILIES } from '../src/core/verse/workbench-types.js';

const NOW = new Date('2026-11-13T18:00:00.000Z');

function claim(i: number, over: Partial<FleetClaim> = {}): FleetClaim {
  return {
    id: `claim-${i}`, repo: 'example/repo', task: `task ${i}`, agent: 'fake-agent',
    claimedAt: NOW.getTime() - 600_000 + i * 1000, expiresAt: NOW.getTime() + 1_800_000, ...over,
  };
}

function board(claims: FleetClaim[], over: Partial<FleetBoard> = {}): FleetBoard {
  // Extra fields below simulate a ledger leaking secrets; the API must drop them.
  return {
    schema: 'fleet.coordination.v1', state: 'known', claims,
    messages: [{ id: 'm1', from: 'fake-agent', to: 'x', body: 'SECRET-BODY', at: 1, expiresAt: 2 }],
    proposals: [], expiredClaims: 3, ...over,
  };
}

async function call(api: ApiModule, method = 'GET', path = PATH) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('fleet coordination-claims api', () => {
  it('returns sorted ISO claims without messages, proposals or lease data', async () => {
    const withLease = { ...claim(1), leaseHash: 'abc', lease: 'def' } as FleetClaim;
    const r = await call(createFleetCoordinationClaimsApi({ read: () => board([withLease, claim(2)]), now: () => NOW }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ v: 1, generatedAt: NOW.toISOString(), source: 'coordination-ledger', state: 'known', expiredClaims: 3 });
    expect(r.body.claims.map((c: { id: string }) => c.id)).toEqual(['claim-2', 'claim-1']);
    expect(r.body.claims[0]).toEqual({
      id: 'claim-2', repo: 'example/repo', task: 'task 2', agent: 'fake-agent',
      claimedAt: new Date(NOW.getTime() - 598_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 1_800_000).toISOString(), expiresInSeconds: 1800,
    });
    expect(r.body).not.toHaveProperty('messages');
    expect(r.body).not.toHaveProperty('proposals');
    expect(r.text).not.toMatch(/leaseHash|lease|SECRET-BODY/);
  });

  it('truncates long tasks to 200 chars', async () => {
    const r = await call(createFleetCoordinationClaimsApi({ read: () => board([claim(1, { task: 'x'.repeat(500) })]), now: () => NOW }));
    expect(r.body.claims[0].task).toHaveLength(200);
  });

  it('degrades to unknown with a reason when the reader throws', async () => {
    const r = await call(createFleetCoordinationClaimsApi({ read: () => { throw new Error('boom /Users/fake/ledger'); }, now: () => NOW }));
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('boom');
    expect(r.text).not.toContain('/Users/fake');
    expect(r.body).toMatchObject({ state: 'unknown', claims: [], expiredClaims: null, reason: 'coordination ledger: reader failed' });
  });

  it('passes an unknown board through as unknown', async () => {
    const r = await call(createFleetCoordinationClaimsApi({ read: () => board([], { state: 'unknown', expiredClaims: null }), now: () => NOW }));
    expect(r.body).toMatchObject({ state: 'unknown', claims: [], expiredClaims: null });
  });

  it('caps claims at 50, newest first', async () => {
    const many = Array.from({ length: 60 }, (_, i) => claim(i));
    const r = await call(createFleetCoordinationClaimsApi({ read: () => board(many), now: () => NOW }));
    expect(r.body.claims).toHaveLength(50);
    expect(r.body.claims[0].id).toBe('claim-59');
  });

  it('rejects non-GET with 405 and ignores other paths', async () => {
    const api = createFleetCoordinationClaimsApi({ read: () => board([]), now: () => NOW });
    const post = await call(api, 'POST');
    expect(post.handled).toBe(true);
    expect(post.status).toBe(405);
    expect(post.body).toEqual({ error: 'method not allowed' });
    expect((await call(api, 'GET', '/api/verse/fleet/other')).handled).toBe(false);
  });

  it('is registered exactly once in the workbench route table', () => {
    const rows = WORKBENCH_ROUTE_FAMILIES.filter(f => (f.prefixes as readonly string[]).includes(PATH));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: 'desktop-command', handler: 'handleFleetCoordinationClaimsApi' });
  });
});
