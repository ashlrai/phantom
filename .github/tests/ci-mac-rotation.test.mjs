import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SLICES, isolatedCases, isolatedSlices, selectSlice } from '../scripts/ci-mac-rotation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const day = (n) => new Date(n * 86_400_000 + 9 * 3_600_000);

test('the scheduled run visits every slice once in any seven consecutive days', () => {
  for (const start of [0, 20_389, 20_754]) {
    const seen = Array.from({ length: 7 }, (_, i) => selectSlice({ eventName: 'schedule', now: day(start + i), releaseTags: [] }));
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4, 5, 6]);
  }
});

test('dispatch, reusable calls and release tags run the complete Mac set', () => {
  const now = day(1);
  assert.equal(selectSlice({ eventName: 'workflow_dispatch', input: 'all', now, releaseTags: [] }), null);
  assert.equal(selectSlice({ eventName: 'workflow_dispatch', input: '', now, releaseTags: [] }), null);
  assert.equal(selectSlice({ eventName: 'workflow_dispatch', input: '4', now, releaseTags: [] }), 4);
  assert.equal(selectSlice({ eventName: 'push', input: undefined, now, releaseTags: [] }), null);
  assert.equal(selectSlice({ eventName: 'schedule', now, releaseTags: ['v3.4.0'] }), null);
  assert.equal(selectSlice({ eventName: 'schedule', now, releaseTags: ['desktop-v0.9.1'] }), null);
  assert.equal(selectSlice({ eventName: 'workflow_dispatch', input: '3', now, releaseTags: ['v3.4.0'] }), null);
  assert.throws(() => selectSlice({ eventName: 'workflow_dispatch', input: '7', now, releaseTags: [] }));
});

test('the seven isolated slices cover every isolated case exactly once', async () => {
  const cases = await isolatedCases(root);
  assert.equal(cases.length, 14);
  const bins = isolatedSlices(cases);
  assert.equal(bins.length, SLICES);
  const flat = bins.flatMap((b) => b.cases.map((c) => c.label));
  assert.deepEqual([...flat].sort(), cases.map((c) => c.label).sort());
  assert.ok(bins.every((b) => b.cases.length > 0 && b.seconds <= 473));
});
