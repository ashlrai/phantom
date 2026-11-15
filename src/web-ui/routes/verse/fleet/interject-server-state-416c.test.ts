import { describe, expect, it } from 'vitest';
import type { OrderRow } from '../fleet-board/order-state-model.js';
import { entryContract, matchOrderRow } from './interject-server-state.js';

const row = (over: Partial<OrderRow>): OrderRow => ({
  at: '2026-11-01 00:08 ET', source: 'Phantom desktop', key: '11-01 00:08', state: 'ASSIGNED', asOf: '2026-11-01T05:00:00Z',
  evidenceSource: '', missing: [], pr: null, owner: null, blocker: null, ...over,
});
const local = { state: 'ASSIGNED' as const, missing: ['x'], asOf: 'local-asof' };
const ok = (...rows: OrderRow[]) => ({ kind: 'ok' as const, asOf: 'a', rows });

describe('matchOrderRow', () => {
  it('matches exact at first', () => {
    const exact = row({ at: 'X', key: 'zz' });
    expect(matchOrderRow([row({}), exact], 'X')).toBe(exact);
  });
  it('matches the key for plain and ET entries', () => {
    const r = row({ at: 'other' });
    expect(matchOrderRow([r], '2026-11-01 00:08')).toBe(r);
    expect(matchOrderRow([r], '2026-11-01 00:08 ET')).toBe(r);
  });
  it('takes the first of several matches', () => {
    const a = row({ state: 'RUNNING' }); const b = row({ state: 'BLOCKED' });
    expect(matchOrderRow([a, b], '2026-11-01 00:08 ET')).toBe(a);
  });
  it('never matches a different order or the dash', () => {
    expect(matchOrderRow([row({})], '2026-11-01 00:09 ET')).toBeNull();
    expect(matchOrderRow([row({ at: '—', key: '—' })], '—')).toBeNull();
  });
});

describe('entryContract', () => {
  it('falls back to local for the dash, unavailable and undefined', () => {
    for (const server of [ok(row({})), { kind: 'unavailable' as const }, undefined]) {
      expect(entryContract(server, server?.kind === 'ok' ? '—' : '2026-11-01 00:08 ET', local))
        .toEqual({ ...local, source: 'local', blocker: null });
    }
  });
  it('falls back to local for an unmatched order', () => {
    expect(entryContract(ok(row({ state: 'RUNNING' })), '2026-11-02 09:00 ET', local).source).toBe('local');
  });
  it('server RUNNING overrides local ASSIGNED and drops the blocker', () => {
    const c = entryContract(ok(row({ state: 'RUNNING', blocker: 'devin', missing: [], asOf: 'srv' })), '2026-11-01 00:08 ET', local);
    expect(c).toEqual({ state: 'RUNNING', missing: [], asOf: 'srv', source: 'server', blocker: null });
  });
  it('server BLOCKED overrides and carries the blocker', () => {
    const c = entryContract(ok(row({ state: 'BLOCKED', blocker: 'devin', missing: ['m'] })), '2026-11-01 00:08 ET', local);
    expect(c).toMatchObject({ state: 'BLOCKED', blocker: 'devin', missing: ['m'], source: 'server' });
    expect(entryContract(ok(row({ state: 'BLOCKED', blocker: undefined })), '2026-11-01 00:08 ET', local).blocker).toBeNull();
  });
});
