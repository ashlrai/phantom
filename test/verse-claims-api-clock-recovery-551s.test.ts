import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetCoordinationClaimsApi, VERSE_FLEET_COORDINATION_CLAIMS_PATH as PATH }
  from '../src/core/verse/fleet-coordination-claims-api.js';

const now = new Date('2026-11-17T12:00:00Z');
const claim: FleetClaim = { id: 'ordinary', repo: 'example/repo', task: 'Owned work',
  agent: 'example-agent', claimedAt: now.getTime(), expiresAt: now.getTime() + 1800_000 };
const damaged = { ...claim, id: 'damaged', claimedAt: 8640000000000001,
  expiresAt: -8640000000000001, lease: 'private-lease' };
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known',
  claims: [claim, damaged], expiredClaims: 2,
  messages: [{ id: 'm', from: 'a', to: 'b', body: 'private-message', at: 1, expiresAt: 2 }],
  proposals: [{ id: 'p', repo: 'r', task: 'private-proposal', to: 'b', at: 1, expiresAt: 2, executionAuthorized: false }] };

async function get(api: ApiModule) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; } } as unknown as ServerResponse;
  expect(await api({ cfg: {} } as VerseApiContext, {} as IncomingMessage, res, PATH, 'GET')).toBe(true);
  expect(status).toBe(200);
  expect(text).not.toMatch(/private-|lease|messages|proposals|NaN/);
  return JSON.parse(text);
}

describe('desktop claims clock recovery', () => {
  it.each([now, new Date(NaN)])('retains ownership with observation %s without mutating evidence', async at => {
    const before = structuredClone(board);
    const read = vi.fn(() => board);
    const mutate = vi.fn<ApiModule>();
    const returns = vi.fn<ApiModule>();
    const api = createFleetCoordinationClaimsApi({ read, now: () => at, mutate, returns });
    for (let i = 0; i < 2; i++) {
      const result = await get(api);
      expect(result).toMatchObject({ v: 1, source: 'coordination-ledger', state: 'known',
        generatedAt: Number.isNaN(at.getTime()) ? 'unknown' : now.toISOString(), expiredClaims: 2 });
      expect(result).not.toHaveProperty('asOf');
      expect(result.claims).toContainEqual({ id: damaged.id, repo: claim.repo, task: claim.task,
        agent: claim.agent, claimedAt: 'unknown', expiresAt: 'unknown', expiresInSeconds: null });
      expect(result.claims).toContainEqual({ ...claim, claimedAt: now.toISOString(),
        expiresAt: new Date(claim.expiresAt).toISOString(),
        expiresInSeconds: Number.isNaN(at.getTime()) ? null : 1800 });
      expect(board).toEqual(before);
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(mutate).not.toHaveBeenCalled();
    expect(returns).not.toHaveBeenCalled();
  });

  it('preserves the healthy response contract', async () => {
    const result = await get(createFleetCoordinationClaimsApi({
      read: () => ({ ...board, claims: [claim] }), now: () => now,
    }));
    expect(result).toEqual({ v: 1, source: 'coordination-ledger', generatedAt: now.toISOString(),
      state: 'known', expiredClaims: 2, claims: [{ ...claim, claimedAt: now.toISOString(),
        expiresAt: new Date(claim.expiresAt).toISOString(), expiresInSeconds: 1800 }] });
  });

  it.each([now, new Date(NaN)])('sanitizes reader failure with observation %s', async at => {
    const result = await get(createFleetCoordinationClaimsApi({ now: () => at,
      read: () => { throw new Error('private-reader private-message private-proposal private-lease'); },
    }));
    expect(result).toEqual({ v: 1, source: 'coordination-ledger',
      generatedAt: Number.isNaN(at.getTime()) ? 'unknown' : now.toISOString(),
      state: 'unknown', claims: [], expiredClaims: null, reason: 'coordination ledger: reader failed' });
  });
});
