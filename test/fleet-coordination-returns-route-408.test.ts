/** GET /api/verse/fleet/coordination-claims/returns: server projection matches the web client contract. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import {
  createFleetCoordinationClaimsApi, VERSE_FLEET_COORDINATION_CLAIMS_PATH,
} from '../src/core/verse/fleet-coordination-claims-api.js';
import {
  createFleetCoordinationReturnsApi, VERSE_FLEET_COORDINATION_RETURNS_PATH as PATH,
} from '../src/core/verse/fleet-coordination-returns-api.js';
import { parseReturns } from '../src/web-ui/routes/verse/fleet-board/returns-model.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const T = NOW.getTime();

function board(): FleetBoard {
  return {
    schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, proposals: [],
    claims: [{ id: 'claim-fake-1', repo: 'fake/repo', task: 'fake task', agent: 'agent-fake-1', claimedAt: T - 1000, expiresAt: T + 60_000 }],
    messages: [{
      id: 'return-claim-fake-1', from: 'agent-fake-1', to: 'fleet', at: T - 500, expiresAt: T + 3_600_000,
      body: 'RESULT VERIFIED fake/repo claim claim-fake-1 task "fake task": pr #12 head abcdef1',
    }],
  };
}

async function call(api: ApiModule, method = 'GET', path = PATH) {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, { url: path } as IncomingMessage, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

const dispatch = (read: () => FleetBoard) =>
  createFleetCoordinationClaimsApi({ read, now: () => NOW });
const direct = (read: () => FleetBoard) =>
  createFleetCoordinationReturnsApi({ read, now: () => NOW });

describe('coordination returns route', () => {
  it('serves a receipt through the real claims dispatch that the web client parses', async () => {
    const seeded = await call(createFleetCoordinationClaimsApi({
      returns: direct(board), read: board, now: () => NOW,
    }));
    expect(seeded).toMatchObject({ handled: true, status: 200 });
    expect(seeded.body.authority).toBe('none');
    expect(seeded.body.generatedAt).toBe(NOW.toISOString());
    const parsed = parseReturns(seeded.body);
    expect(parsed.state).toBe('known');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.dropped).toBe(0);
    expect(parsed.rows[0]).toMatchObject({ result: 'VERIFIED', pr: 12, head: 'abcdef1', claimId: 'claim-fake-1' });
    expect(seeded.body.returns[0].temporal).toBe('current');
  });

  it('answers unknown, not an error, when the reader throws', async () => {
    const r = await call(direct(() => { throw new Error('secret-path /fake/leak'); }));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('leak');
    expect(r.body.state).toBe('unknown');
    expect(parseReturns(r.body).state).toBe('unknown');
  });

  it('answers 405 to non-GET and declines other paths', async () => {
    expect(await call(direct(board), 'POST')).toMatchObject({ handled: true, status: 405 });
    expect((await call(direct(board), 'GET', '/api/verse/fleet/other')).handled).toBe(false);
  });

  it('leaves the base claims route unchanged', async () => {
    const r = await call(dispatch(board), 'GET', VERSE_FLEET_COORDINATION_CLAIMS_PATH);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      v: 1, generatedAt: NOW.toISOString(), source: 'coordination-ledger', state: 'known', expiredClaims: 0,
      claims: [{
        id: 'claim-fake-1', repo: 'fake/repo', task: 'fake task', agent: 'agent-fake-1',
        claimedAt: new Date(T - 1000).toISOString(), expiresAt: new Date(T + 60_000).toISOString(), expiresInSeconds: 60,
      }],
    });
  });
});
