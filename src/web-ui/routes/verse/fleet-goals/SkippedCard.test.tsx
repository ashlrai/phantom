import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SkippedCard } from './SkippedCard.js';
let data: unknown;
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ status: 'success', data }), useRefetch: () => vi.fn() }));
afterEach(() => { data = undefined; });
const base = { schema: 'jobs.skipped.v1', v: 1, hours: 24, as_of: 'x', known: true, repeated: [], leader_skipped: [] };
it('shows the count, codes and families', () => {
  data = { ...base, total: 1, repeated: ['RQ-AAA1'], by_family: [{ family: 'RQ-AAA*', count: 1 }],
    by_code: [{ code: 13, meaning: 'Names exist.', count: 1, jobs: [{ job: 'RQ-AAA1', family: 'RQ-AAA*', lane: 'claude', repo: 'phantom', at: 't', code: 13, meaning: 'Names exist.', leader: true }] }] };
  render(<SkippedCard visible />);
  expect(screen.getByText('Skipped: 1 in the last 24 hours')).toBeTruthy();
  expect(screen.getByText(/Code 13: Names exist\. \(1\)/)).toBeTruthy();
  expect(screen.getByText(/Skipped more than once: RQ-AAA1/)).toBeTruthy();
});
it('says plainly when nothing was skipped and when it is unknown', () => {
  data = { ...base, total: 0, by_code: [], by_family: [] };
  const view = render(<SkippedCard visible />);
  expect(screen.getByText(/No jobs were skipped in the last 24 hours\./)).toBeTruthy();
  data = { ...base, known: false, total: 0, by_code: [], by_family: [] };
  view.rerender(<SkippedCard visible />);
  expect(screen.getByText(/Skipped: unknown/)).toBeTruthy();
});
