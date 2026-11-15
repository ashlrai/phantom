import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import { MergeWaitCard } from './MergeWaitCard.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); evictAll(); });

const response = (ledger: string, report: object) => ({ schema: 'verse.merge-latency.v1', ledger, report: { window_hours: 24, ...report } });

it('renders stages, the verdict and a retry row', async () => {
  vi.mocked(apiGet).mockResolvedValue(response('present', {
    pr_stages: [{ repo: 'fake/repo', pr: 3, queue_wait_s: 60, required_checks_s: 600, merge_s: 30 }],
    queue_retries: { retryable: [{ repo: 'fake/repo', pr: 5, waiting_s: 120, retries_left: 2 }], needs_person: [] },
  }));
  render(<MergeWaitCard visible />);
  expect(await screen.findByText('Where PRs wait')).toBeInTheDocument();
  expect(await screen.findByText('Queue')).toBeInTheDocument();
  expect(screen.getByText('median 10m')).toBeInTheDocument();
  expect(screen.getByText('median 30s')).toBeInTheDocument();
  expect(screen.getAllByText('1 of 1 known')).toHaveLength(3);
  expect(screen.getByText('median 10m')).toBeInTheDocument();
  expect(screen.getByText(/Checks are the longest wait/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'fake/repo#5' })).toHaveAttribute('href', 'https://github.com/fake/repo/pull/5');
  expect(vi.mocked(apiGet).mock.calls[0]![0]).toBe('/api/verse/fleet/merge-latency?hours=24');
});

it('renders the missing-ledger note', async () => {
  vi.mocked(apiGet).mockResolvedValue(response('missing', { pr_stages: null }));
  render(<MergeWaitCard visible />);
  expect(await screen.findByText('phm fleet merge-latency --record <event JSON>')).toBeInTheDocument();
  expect(screen.getByText(/No merge observations yet\./)).toBeInTheDocument();
});

it('renders a failure note', async () => {
  vi.mocked(apiGet).mockRejectedValue(new Error('boom'));
  render(<MergeWaitCard visible />);
  expect(await screen.findByText('Merge wait times are unavailable.')).toBeInTheDocument();
});
