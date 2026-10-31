import { expect, it } from 'vitest';
import { applyStepsCopy } from './update-apply-copy.js';

it('formats known and fallback labels, statuses, and durations', () => {
  expect(applyStepsCopy([
    { name: 'status', ok: true, ms: 800, note: null },
    { name: 'fetch', ok: true, ms: 12000, note: null },
    { name: 'ahead', ok: true, ms: 125000, note: null },
    { name: 'update', ok: false, ms: 59999, note: 'failure' },
    { name: 'new-step', ok: true, ms: 0, note: null },
    { name: 'constructor', ok: true, ms: 9950, note: null },
  ])).toEqual([
    { label: 'Status', status: 'ok', duration: '0.8s' },
    { label: 'Fetch', status: 'ok', duration: '12s' },
    { label: 'Ahead check', status: 'ok', duration: '2m 05s' },
    { label: 'Update', status: 'failed', duration: '1m 00s' },
    { label: 'New Step', status: 'ok', duration: '0s' },
    { label: 'Constructor', status: 'ok', duration: '10s' },
  ]);
  expect(applyStepsCopy(undefined)).toEqual([]);
});
