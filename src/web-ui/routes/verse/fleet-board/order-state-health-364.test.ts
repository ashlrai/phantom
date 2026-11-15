/** RQ-PHX-ORDERSTRIPLIVEHONEST364 — pure health reading. Fake names only. */
import { expect, it } from 'vitest';
import { orderStripHealth } from './order-state-health.js';

it('healthy gives no notice', () => {
  expect(orderStripHealth({ live: 'healthy', sources: { inbox: 'healthy' } }))
    .toEqual({ liveChecked: true, degradedSources: [], notice: null });
});
it('live unavailable gives the RUNNING-not-checked notice', () => {
  const h = orderStripHealth({ live: 'unavailable', sources: {} });
  expect(h.liveChecked).toBe(false);
  expect(h.notice).toBe('Live workers unreadable · RUNNING not checked');
});
it('lists only degraded sources, sorted', () => {
  const h = orderStripHealth({ live: 'healthy', sources: { ready: 'error', ok: 'healthy', inbox: 'stale' } });
  expect(h.degradedSources).toEqual(['inbox', 'ready']);
  expect(h.notice).toBe('Order sources degraded: inbox, ready');
});
it('combines live and source notices', () => {
  expect(orderStripHealth({ live: 'unavailable', sources: { inbox: 'x' } }).notice)
    .toBe('Live workers unreadable · RUNNING not checked · Order sources degraded: inbox');
});
it("sources 'unavailable' gives all", () => {
  expect(orderStripHealth({ live: 'healthy', sources: 'unavailable' }).degradedSources).toEqual(['all']);
});
it('missing live gives null and no live notice', () => {
  const h = orderStripHealth({ sources: {} });
  expect(h.liveChecked).toBeNull();
  expect(h.notice).toBeNull();
  expect(orderStripHealth({ live: 'weird' }).liveChecked).toBeNull();
});
it('hostile inputs do not throw and stay bounded', () => {
  for (const x of [null, undefined, 7, 'str', [], { sources: [] }, { sources: null }, { live: {} }]) {
    expect(() => orderStripHealth(x)).not.toThrow();
  }
  expect(orderStripHealth(null)).toEqual({ liveChecked: null, degradedSources: [], notice: null });
  expect(orderStripHealth({ sources: ['a'] }).notice).toBeNull();
  const long = orderStripHealth({ sources: { ['n'.repeat(80)]: 'bad' } });
  expect(long.degradedSources[0]).toHaveLength(40);
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src${i}`, 'bad']));
  const m = orderStripHealth({ sources: many });
  expect(m.notice).toContain('+4 more');
  expect(m.notice!.length).toBeLessThan(200);
});
