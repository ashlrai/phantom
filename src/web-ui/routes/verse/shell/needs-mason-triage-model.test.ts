import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { AUTO_RESOLVE_REPLY, batchResolveSummary, groupNeedsMasonRows, hardLimitChip } from './needs-mason-triage-model.js';

it('sends a billing line to hardLimit and a plain line to auto', () => {
  const grouped = groupNeedsMasonRows([
    { id: 'a', text: 'Approve the fake $40 plan change' },
    { id: 'b', text: 'unpark RQ-FAKE-1' },
  ]);
  expect(grouped.hardLimit).toHaveLength(1);
  expect(grouped.hardLimit[0]).toMatchObject({ id: 'a', limit: 'money', reason: 'money or billing' });
  expect(grouped.auto).toEqual([{ id: 'b', text: 'unpark RQ-FAKE-1' }]);
});

it('keeps order within each group', () => {
  const grouped = groupNeedsMasonRows([
    { id: '1', text: 'unpark RQ-FAKE-1' }, { id: '2', text: 'Delete the fake folder' },
    { id: '3', text: 'unpark RQ-FAKE-2' }, { id: '4', text: 'Email the fake list' },
  ]);
  expect(grouped.auto.map(row => row.id)).toEqual(['1', '3']);
  expect(grouped.hardLimit.map(row => row.id)).toEqual(['2', '4']);
});

it('gives two empty groups for empty input', () => {
  expect(groupNeedsMasonRows([])).toEqual({ hardLimit: [], auto: [] });
});

it('summarizes batch counts', () => {
  expect(batchResolveSummary({ ok: 3, duplicate: 1, failed: 0 })).toBe('Resolved 3, 1 already resolved, 0 failed');
  expect(batchResolveSummary({ ok: 0, duplicate: 0, failed: 2 })).toBe('Resolved 0, 0 already resolved, 2 failed');
});

it('names the limit in the chip', () => {
  expect(hardLimitChip('money or billing')).toBe('Hard limit: money or billing');
});

it('uses the same reply literal as the CLI', () => {
  const cli = readFileSync('src/cli/fleet-needs-triage.ts', 'utf8');
  expect(cli).toContain(`'${AUTO_RESOLVE_REPLY}'`);
});
