import { expect, it } from 'vitest';
import { memoryView } from '../src/core/fleet/memory-view.js';
import type { FleetMemoryResponse } from '../src/web-ui/routes/verse/fleet-host/memory-guard-query.js';
import type { FleetStandbyView } from '../src/web-ui/routes/verse/fleet-host/standby-card-model.js';
import { deriveHostGuardNeedsYou as derive } from '../src/web-ui/routes/verse/shell/host-guard-needs-you.js';

const memory = (free: number | null = 50, stopped: string[] | null = []): FleetMemoryResponse => ({
  v: 1, generatedAt: '', memory: memoryView({ free_pct: free, ts: 1 }, { stopped }, 1000),
});
const standby = (fields: object): FleetStandbyView => ({ v: 1, generatedAt: '', configured: true,
  available: true, ready: true, blocker: null, leaseHolder: null, snapshotAgeSec: null, ...fields } as FleetStandbyView);

it('shows stopped workers, limits job details, and opens Mac host', () => {
  const [row] = derive(memory(50, ['a', 'b', 'c', 'd', 'e', 'f', 'g']), null, 0);
  expect(row).toMatchObject({ id: 'memory-guard-stopped', severity: 'urgent', title: 'Memory guard stopped 7 workers',
    detail: 'a, b, c, d, e, +2 more', target: 'fleet', open: { kind: 'pane', paneId: 'fleet-host' },
    nextStep: 'Workers resume when pressure drops; open Mac host to see the level' });
  expect(derive(memory(50, ['one']), null, 0)[0].title).toBe('Memory guard stopped 1 worker');
});
it('shows fresh low memory', () => {
  expect(derive(memory(9), null, 0)).toEqual([expect.objectContaining({ id: 'memory-low', severity: 'urgent',
    title: 'Mac memory free 9%', nextStep: 'Quit an app you are not using, or let the guard pause workers' })]);
});
it('shows only stale rather than low memory and uses whole minutes', () => {
  const read = memory(1);
  Object.assign(read.memory.sample, { stale: true, age_ms: 179999 });
  expect(derive(read, null, 0)).toEqual([expect.objectContaining({ id: 'memory-sample-stale', severity: 'attention',
    title: 'Memory sample is 2 min old', nextStep: 'Check launchd label ai.ashlr.memguard' })]);
  read.memory.sample.age_ms = null;
  expect(derive(read, null, 0)[0].title).toContain('age unknown');
});
it.each(['offline', null, ''])('shows a blocked standby (%s)', blocker => {
  expect(derive(null, standby({ ready: false, blocker }), 0)).toEqual([expect.objectContaining({
    id: 'standby-not-ready', severity: 'attention', title: `Second computer cannot take over: ${blocker || 'unknown'}` })]);
});
it('shows a configured standby without a reading', () => {
  expect(derive(null, standby({ available: false }), 0)).toEqual([expect.objectContaining({ id: 'standby-no-reading', severity: 'attention' })]);
});
it.each([null, undefined])('ignores absent reads (%s)', read => { expect(derive(read, read, 0)).toEqual([]); });
it('ignores optional standby and healthy readings', () => {
  expect(derive(memory(), standby({ configured: false }), 0)).toEqual([]);
  expect(derive(memory(10), standby({}), 0)).toEqual([]);
});
it.each([null, NaN, Infinity])('never treats unknown free memory as low (%s)', free => {
  const read = memory();
  read.memory.sample.free_pct = free;
  read.memory.memguard.stopped = null;
  expect(derive(read, null, 0)).toEqual([]);
});
