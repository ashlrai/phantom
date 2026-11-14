import { expect, it } from 'vitest';
import { formatAge, narrowRuntimeIdentity } from './runtime-identity-model.js';
const identity = { host: 'h1', platform: 'darwin', asOf: '2026-11-13T00:00:00Z', installedVersion: '1.2.0', sourceVersion: '1.3.0', versionDrift: true,
  fleetState: { path: '~/s.json', mtime: 'x', ageSeconds: 180, stale: false }, tailnetName: 'h1.ts.net', reasons: ['why'] };
const env = (i: unknown) => ({ v: 1, generatedAt: 'g', identity: i });
it('narrows a full payload', () => {
  expect(narrowRuntimeIdentity(env(identity))).toMatchObject({ host: 'h1', versionDrift: true, tailnetName: 'h1.ts.net', reasons: ['why'], fleetState: { ageSeconds: 180, stale: false } });
});
it('turns missing or mistyped fields into unknown', () => {
  const v = narrowRuntimeIdentity(env({ host: 5, fleetState: 'x', reasons: 'no' }))!;
  expect(v).toMatchObject({ host: 'unknown', installedVersion: 'unknown', tailnetName: 'unknown', versionDrift: false, reasons: [], fleetState: { ageSeconds: 'unknown', stale: 'unknown' } });
});
it.each([null, 'x', { v: 2, generatedAt: 'g', identity }, { v: 1, identity }, { v: 1, generatedAt: 'g' }, { v: 1, generatedAt: 'g', identity: [] }])('rejects bad envelope %#', (raw) => {
  expect(narrowRuntimeIdentity(raw)).toBeNull();
});
it('formats age', () => {
  expect(formatAge(180)).toBe('3m old');
  expect(formatAge(7300)).toBe('2h old');
  expect(formatAge('unknown')).toBe('unknown');
  expect(narrowRuntimeIdentity(env({ fleetState: { ageSeconds: 'unknown' } }))!.fleetState.ageSeconds).toBe('unknown');
});
it.each([[true, true], [false, false], ['unknown', 'unknown'], ['yes', 'unknown']])('stale %j -> %j', (inp, out) => {
  expect(narrowRuntimeIdentity(env({ fleetState: { stale: inp } }))!.fleetState.stale).toBe(out);
});
