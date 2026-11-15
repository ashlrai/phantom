/** RQ-PHX-ORDERSTRIPBLOCKER369 — why-BLOCKED text + lanes health. Fake names only. */
import { expect, it } from 'vitest';
import { orderRowView, parseRow } from './order-state-model.js';
import { orderStripHealth } from './order-state-health.js';

const base = {
  at: '2026-11-13T17:13:00.000Z', source: 'slack', key: 'order-fake-1', state: 'BLOCKED',
  asOf: '2026-11-13T17:14:00.000Z', evidenceSource: 'ledger', missing: [], pr: null,
};
const held = 'lane codex-personal held until 2026-11-15T00:00:00.000Z';

it('BLOCKED row with a blocker gets waiting-on text', () => {
  const row = parseRow({ ...base, blocker: held });
  expect(row?.blocker).toBe(held);
  expect(orderRowView(row!).blockerText).toBe(`waiting on: ${held}`);
});

it('non-BLOCKED rows never show a blocker even when one is present', () => {
  for (const state of ['RECEIVED', 'ASSIGNED', 'RUNNING', 'VERIFIED']) {
    const row = parseRow({ ...base, state, blocker: held });
    expect(row?.blocker).toBe(held);
    expect(orderRowView(row!).blockerText).toBeNull();
  }
});

it('absent or hostile blocker drops to null', () => {
  expect(parseRow(base)?.blocker).toBeNull();
  for (const bad of [null, 5, {}, ['x'], 'a'.repeat(201), 'rm -rf /Users/x', '<script>alert(1)</script>']) {
    const row = parseRow({ ...base, blocker: bad });
    expect(row).not.toBeNull();
    expect(row?.blocker).toBeNull();
    expect(orderRowView(row!).blockerText).toBeNull();
  }
});

it('lanes unavailable → lanesChecked false and BLOCKED-not-checked notice', () => {
  const h = orderStripHealth({ v: 1, asOf: '2026-11-13T17:14:00.000Z', lanes: 'unavailable', live: 'healthy', sources: { inbox: 'healthy' } });
  expect(h.lanesChecked).toBe(false);
  expect(h.notice).toBe('Lane holds unreadable · BLOCKED not checked');
});

it('lanes healthy → lanesChecked true and no such notice', () => {
  const h = orderStripHealth({ v: 1, asOf: '2026-11-13T17:14:00.000Z', lanes: 'healthy', live: 'healthy', sources: { inbox: 'healthy' } });
  expect(h.lanesChecked).toBe(true);
  expect(h.notice).toBeNull();
});

it('lanes absent (older server) or unreadable → treated as null', () => {
  for (const body of [
    { v: 1, asOf: 'x', live: 'healthy', sources: {} },
    { v: 1, asOf: 'x', lanes: 'weird', live: 'healthy', sources: {} },
  ]) {
    const h = orderStripHealth(body);
    expect(h.lanesChecked ?? null).toBeNull();
    expect(h.notice).toBeNull();
  }
});

it('lanes notice joins with live and source parts using · separators', () => {
  const h = orderStripHealth({ lanes: 'unavailable', live: 'unavailable', sources: { inbox: 'stale' } });
  expect(h.notice).toBe('Live workers unreadable · RUNNING not checked · Lane holds unreadable · BLOCKED not checked · Order sources degraded: inbox');
});
