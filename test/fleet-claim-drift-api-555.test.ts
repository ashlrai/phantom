/** GET /api/verse/fleet/runtime-identity/claim-drift: read-only claim-store drift verdict. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { CLAIM_DRIFT_SCHEMA, type ClaimDriftRow, type ClaimStoreDrift } from '../src/core/fleet/claim-store-drift.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';
import {
  createFleetClaimDriftApi,
  CLAIM_DRIFT_FIELD_CAP,
  VERSE_FLEET_CLAIM_DRIFT_PATH as PATH,
} from '../src/core/verse/fleet-claim-drift-api.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const row = (o: Partial<ClaimDriftRow> = {}): ClaimDriftRow => ({
  id: 'fake-claim-1', cursor: 3, receivedAt: NOW.toISOString(), owner: 'fake-owner-a',
  leaseUntil: '2026-11-14T19:00:00.000Z', ...o,
});
const drift = (o: Partial<ClaimStoreDrift> = {}): ClaimStoreDrift => ({
  schema: CLAIM_DRIFT_SCHEMA, asOf: NOW.toISOString(), bus: 'available', coordination: 'available',
  matched: 2, busOnly: [], coordOnly: [], ownerMismatch: [], state: 'VERIFIED', missing: [], ...o,
});

async function call(api: ApiModule, method = 'GET', path = PATH, url = path) {
  const state = { status: 0, text: '' };
  const res = {
    writeHead(code: number) { state.status = code; return this; },
    end(body: string) { state.text = body; },
  } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, { url } as IncomingMessage, res, path, method);
  return { handled, status: state.status, text: state.text, body: state.text ? JSON.parse(state.text) : null };
}
const mk = (read: () => ClaimStoreDrift) => createFleetClaimDriftApi({ read, now: () => NOW });

describe('claim-drift HTTP route', () => {
  it('passes VERIFIED through', async () => {
    const r = await call(mk(() => drift()));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, authority: 'none', generatedAt: NOW.toISOString(), drift: drift() });
  });

  it('passes DRIFT with each row kind through', async () => {
    const d = drift({
      state: 'DRIFT',
      busOnly: [row({ id: 'bus-only-1' })],
      coordOnly: [row({ id: 'coord-only-1', sourceId: 'coord-only-1:1:2' })],
      ownerMismatch: [row({ id: 'mismatch-1', busOwner: 'fake-owner-a', coordOwner: 'fake-owner-b' })],
    });
    const r = await call(mk(() => d));
    expect(r.body.drift).toEqual(d);
  });

  it('passes UNKNOWN through', async () => {
    const d = drift({ state: 'UNKNOWN', bus: 'unavailable', missing: ['bus'] });
    expect((await call(mk(() => d))).body.drift).toEqual(d);
  });

  it('a throwing reader gives UNKNOWN without the message', async () => {
    const r = await call(mk(() => { throw new Error('secret-path /home/x exploded'); }));
    expect(r.status).toBe(200);
    expect(r.body.drift).toMatchObject({ state: 'UNKNOWN', missing: ['bus', 'coordination'], asOf: NOW.toISOString() });
    expect(r.text).not.toContain('secret-path');
  });

  it('rejects any query with 400 before reading', async () => {
    const read = vi.fn(() => drift());
    const r = await call(mk(read), 'GET', PATH, `${PATH}?x=1`);
    expect(r).toMatchObject({ handled: true, status: 400 });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects POST with 405 before reading', async () => {
    const read = vi.fn(() => drift());
    const r = await call(mk(read), 'POST');
    expect(r).toMatchObject({ handled: true, status: 405 });
    expect(read).not.toHaveBeenCalled();
  });

  it('ignores other paths', async () => {
    expect((await call(mk(() => drift()), 'GET', `${PATH}/x`)).handled).toBe(false);
  });

  it('caps long owner and id strings', async () => {
    const long = 'x'.repeat(500);
    const d = drift({
      state: 'DRIFT',
      ownerMismatch: [row({ id: long, owner: long, busOwner: long, coordOwner: long })],
      coordOnly: [row({ sourceId: long })],
    });
    const out = (await call(mk(() => d))).body.drift;
    const m = out.ownerMismatch[0];
    for (const v of [m.id, m.owner, m.busOwner, m.coordOwner, out.coordOnly[0].sourceId]) {
      expect(v).toHaveLength(CLAIM_DRIFT_FIELD_CAP);
    }
  });

  it('dispatches through the runtime-identity api without falling to hostReach', async () => {
    const hostReach = vi.fn(async () => true);
    const api = createFleetRuntimeIdentityApi({
      claimDrift: mk(() => drift()), hostReach, now: () => NOW,
    });
    const r = await call(api);
    expect(r.status).toBe(200);
    expect(r.body.drift.state).toBe('VERIFIED');
    expect(hostReach).not.toHaveBeenCalled();
  });
});
