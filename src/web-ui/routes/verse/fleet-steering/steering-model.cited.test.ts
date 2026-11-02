import { expect, it } from 'vitest';
import type { OrderTraceJob } from '../fleet-inbox/order-trace-model.js';
import { citedJobsLine } from './steering-model.js';

it('reports when no job cites an order', () => {
  expect(citedJobsLine([], null)).toBe('No job cites this order yet');
});

it('counts published jobs separately from open PRs', () => {
  const jobs: OrderTraceJob[] = [
    { id: 'RQ-FAKE-PUBLISHED', lane: null, state: 'published', url: null },
    { id: 'RQ-FAKE-PR1', lane: null, state: 'published', url: 'https://github.com/example/fake/pull/2001' },
    { id: 'RQ-FAKE-PR2', lane: null, state: 'published', url: 'https://github.com/example/fake/pull/2002' },
  ];
  expect(citedJobsLine(jobs, 2)).toBe('3 jobs cite this order · 1 published · 2 open PRs');
});

it('keeps first reaction timing distinct from citation evidence', () => {
  expect(citedJobsLine([], 3)).toBe('No job cites this order yet · first reaction 3 min later');
  expect(citedJobsLine([], 0)).toBe('No job cites this order yet · first reaction 0 min later');
});
