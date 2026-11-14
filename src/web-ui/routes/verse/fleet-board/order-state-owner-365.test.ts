import { expect, it } from 'vitest';
import { orderRowView, parseRow } from './order-state-model.js';

const base = {
  at: '2026-11-13T17:13:00.000Z', source: 'slack', key: 'order-fake-1', state: 'ASSIGNED',
  asOf: '2026-11-13T17:14:00.000Z', evidenceSource: 'ledger', missing: [], pr: null,
};

it('parseRow: missing owner → null, malformed owner → null, row kept', () => {
  expect(parseRow(base)?.owner).toBeNull();
  for (const bad of [5, 'x', { job: 7, lane: 'a' }, { job: '' }, { job: 'RQ-A', lane: 3 }]) {
    const row = parseRow({ ...base, owner: bad });
    expect(row).not.toBeNull();
    expect(row?.owner).toBeNull();
  }
});

it('parseRow: valid owner kept', () => {
  expect(parseRow({ ...base, owner: { job: 'RQ-PHX-FOO', lane: 'devin' } })?.owner).toEqual({ job: 'RQ-PHX-FOO', lane: 'devin' });
  expect(parseRow({ ...base, owner: { job: 'RQ-PHX-FOO', lane: null } })?.owner).toEqual({ job: 'RQ-PHX-FOO', lane: null });
});

it('ownerText covers lane, no lane, none, and caps the job', () => {
  const view = (owner: unknown) => orderRowView(parseRow({ ...base, owner })!).ownerText;
  expect(view({ job: 'RQ-X', lane: 'devin' })).toBe('RQ-X (devin)');
  expect(view({ job: 'RQ-X', lane: null })).toBe('RQ-X');
  expect(view(null)).toBe('no owner');
  expect(view(undefined)).toBe('no owner');
  expect(view({ job: `RQ-${'A'.repeat(197)}`, lane: null })).toHaveLength(60);
});
