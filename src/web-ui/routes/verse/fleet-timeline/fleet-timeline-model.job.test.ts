import { expect, it } from 'vitest';
import { jobFromItem } from './fleet-timeline-model.js';

it('returns only job IDs accepted by the worker log', () => {
  const item = { id: 'RQ-PHX-FOO', start: 1, end: null, status: 'running' };
  expect(jobFromItem(item)).toBe('RQ-PHX-FOO');
  for (const id of ['bad id', '', '../secret', 'ab', 'a'.repeat(81)]) {
    expect(jobFromItem({ ...item, id })).toBeNull();
  }
});
