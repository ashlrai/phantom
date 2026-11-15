import { expect, it } from 'vitest';
import { parseSurfaceOwners, surfaceOwnerLine } from './surface-owner-model.js';

const row = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, authority: 'none', surface: 'slack-bridge', asOf: '2026-11-13T12:00:00Z',
  owner: 'dot', ownerSource: 'advisory-claim', liveClaims: [{ id: 'c1', agent: 'dot', expiresInSeconds: 121 }],
  lastLanded: null, scannedPaths: [], reasons: [], ...extra,
});
const parse = (...surfaces: unknown[]) => parseSurfaceOwners({ v: 1, authority: 'none', surfaces });

it('labels a single advisory owner with minutes remaining', () => {
  expect(surfaceOwnerLine(parse(row())[0]!)).toBe('dot (advisory claim, expires in 3m)');
});
it('never promotes landed history to owner', () => {
  const parsed = parse(row({ owner: '', ownerSource: 'none', liveClaims: [],
    lastLanded: { jobId: 'J392', pr: 392, date: '2026-11-13', path: 'src/example.ts' } }));
  expect(surfaceOwnerLine(parsed[0]!)).toBe('no live claim');
  expect(parsed[0]?.lastLanded?.pr).toBe(392);
});
it('shows UNKNOWN with only its first reason', () => {
  expect(surfaceOwnerLine(parse(row({ owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [],
    reasons: ['ledger unreadable', 'second reason'] }))[0]!)).toBe('unknown: ledger unreadable');
});
it('rejects invalid envelopes', () => {
  for (const body of [null, [], {}, { v: 2, authority: 'none', surfaces: [row()] },
    { v: 1, authority: 'execution', surfaces: [row()] }]) expect(parseSurfaceOwners(body)).toEqual([]);
});
it('drops malformed rows while retaining valid evidence', () => {
  expect(parse(null, {}, row({ surface: 'unsupported' }), row({ owner: 3 }), row({ reasons: [5] }),
    row({ liveClaims: [{ id: 'c1', agent: 'dot', expiresInSeconds: -1 }] }),
    row({ liveClaims: [{ id: 'c1', agent: 'other', expiresInSeconds: 60 }] }),
    row({ lastLanded: { jobId: 'bad', pr: '392', date: '2026-11-13', path: 'x' } }), row())).toHaveLength(1);
});
