import { expect, it } from 'vitest';
import { narrowFleetStandby, standbySentence, type FleetStandbyView } from './standby-card-model.js';
const base = { v: 1 as const, generatedAt: '2026-11-02T00:00:00Z' };
const ready = { ...base, configured: true as const, available: true as const, ready: true, blocker: null, leaseHolder: null, snapshotAgeSec: 240 };
it.each([null, {}, { ...ready, v: 2 }, { ...ready, ready: 'true' }, { ...ready, configured: 1 }, { ...ready, blocker: 1 }, { ...ready, leaseHolder: false }, { ...ready, snapshotAgeSec: '240' }, { ...ready, snapshotAgeSec: NaN }, { ...ready, snapshotAgeSec: -1 }])('rejects malformed views %j', raw => {
  expect(narrowFleetStandby(raw)).toBeNull();
});
it.each([
  [{ ...base, configured: false }, 'Second computer: not set up. Run ashlr fleet standby --help.', 'muted'],
  [{ ...base, configured: true, available: false }, 'Second computer: no reading.', 'muted'],
  [ready, 'Second computer can take over. Up to 4m of work would be lost.', 'ok'],
  [{ ...ready, ready: false, blocker: 'snapshot-stale' }, 'Second computer cannot take over: snapshot-stale.', 'warn'],
  [{ ...ready, snapshotAgeSec: null }, 'Second computer can take over. Snapshot age is unknown.', 'ok'],
] as const)('describes each state', (view, text, tone) => {
  expect(narrowFleetStandby(view)).toEqual(view);
  expect(standbySentence(view as FleetStandbyView)).toEqual({ text, tone });
});
it.each([[30, '30 sec'], [7200, '2 h'], [172800, '2 days']] as const)('formats age %i', (snapshotAgeSec, age) => {
  expect(standbySentence({ ...ready, snapshotAgeSec }).text).toContain(`Up to ${age}`);
});
