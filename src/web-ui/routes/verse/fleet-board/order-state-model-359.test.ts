import { expect, it } from 'vitest';
import { orderRowView, parseOrderStateBody, type OrderRow } from './order-state-model.js';

const row = (over: Record<string, unknown> = {}) => ({
  at: '2026-11-13T17:13:00.000Z', source: 'slack', key: 'order-fake-1', state: 'RUNNING',
  asOf: '2026-11-13T17:14:00.000Z', evidenceSource: 'ledger', missing: [], pr: null, ...over,
});
const body = (orders: unknown[]) => ({ v: 1, asOf: '2026-11-13T17:15:00.000Z', sources: 'unavailable', orders });

it('parses ok bodies and drops malformed rows and unknown states', () => {
  const r = parseOrderStateBody(body([row(), row({ state: 'DONE' }), row({ missing: [1] }), null, row({ at: 5 })]));
  expect(r.kind).toBe('ok');
  if (r.kind === 'ok') { expect(r.rows).toHaveLength(1); expect(r.asOf).toBe('2026-11-13T17:15:00.000Z'); }
});

it('treats malformed bodies as unavailable, not empty', () => {
  for (const b of [null, 'x', 42, {}, { v: 2, asOf: 'a', orders: [] }, { v: 1, orders: [] }, { v: 1, asOf: 'a', orders: {} }]) {
    expect(parseOrderStateBody(b)).toEqual({ kind: 'unavailable' });
  }
});

it('empty orders is ok with no rows', () => {
  expect(parseOrderStateBody(body([]))).toEqual({ kind: 'ok', asOf: '2026-11-13T17:15:00.000Z', rows: [] });
});

it('builds the view', () => {
  const r = parseOrderStateBody(body([row({ state: 'BLOCKED', missing: ['pr', 'ci'], pr: 'https://github.com/org-x/repo-y/pull/12' })]));
  const v = orderRowView((r as { rows: OrderRow[] }).rows[0]!);
  expect(v.time).toMatch(/^\d{2}:\d{2}$/);
  expect(v.source).toBe('slack');
  expect(v.state).toBe('BLOCKED');
  expect(v.missingText).toBe('pr, ci');
  expect(v.prUrl).toBe('https://github.com/org-x/repo-y/pull/12');
});

it('prints none for no missing evidence and unknown for a bad time', () => {
  const v = orderRowView(row({ at: 'nope' }) as OrderRow);
  expect(v.missingText).toBe('none');
  expect(v.time).toBe('unknown');
});

it('only links github pull urls', () => {
  for (const pr of ['http://github.com/a/b/pull/1', 'https://example.com/a/b/pull/1', 'https://github.com/a/b/pull/x', 'https://github.com/a/b/pull/1/files', 'javascript:alert(1)', '']) {
    expect(orderRowView(row({ pr }) as OrderRow).prUrl).toBeNull();
  }
});
