import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { LiveFleetBoard } from './LiveFleetBoard.js';

const lanes = (remainingPct: number | null) => ({
  generatedAt: '2026-11-07T00:00:00Z',
  sources: { queue: { state: 'healthy' }, usage: { state: 'healthy' }, budgets: { state: 'healthy' } },
  lanes: [{ lane: 'claude', liveJobs: 1, queueDepth: 2, credit: { state: 'observed', remainingPct, observedAt: '2026-11-06T00:00:00Z' } }],
});
const activity = { ts: '2026-11-07T00:00:00Z', recentActionsSource: { sourceState: 'healthy' }, recentMergesSourceQuality: { sourceState: 'healthy' }, recentActions: [{ ts: '2026-11-07T00:00:00Z', summary: 'Working on tests', repo: 'phantom', outcome: 'running' }], recentMerges: [{ ts: '2026-11-07T00:00:00Z', repo: 'phantom', engine: 'claude' }] };
const verified = {
  v: 1, schema: 'fleet.verified-completion.v1', generatedAt: '2026-11-07T00:00:00Z',
  sourceState: 'healthy', scanned: 10, dropped: 0, truncated: false, windowMs: 86_400_000,
  eligible: 4, verified: 3, failed: 1, pending: 0, rate: 0.75,
  claims: { published: 3, batchMembers: 1, outcomes: 0 }, completedUnpublished: 0,
  duplicates: { multiPrJobs: 0, sharedPrUrls: 1 }, falseCompletions: 1, unauthorizedActions: 0,
  byLane: { devin: { eligible: 4, verified: 3, failed: 1, pending: 0 } },
  detail: { falseCompletionJobs: ['RQ-X-1'], multiPrJobs: [], sharedPrUrls: ['https://github.com/ashlrai/phantom/pull/9'], unauthorizedJobs: [] },
};
const respond = (url: string) => url.includes('/lanes') ? lanes(64) : url.includes('verified-completion') ? verified : activity;

beforeEach(() => evictAll());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('LiveFleetBoard', () => {
  it('renders measured quota, provider mark, activity and merge evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(respond(url)))));
    const { container } = render(<LiveFleetBoard />);
    expect(await screen.findByRole('meter', { name: 'claude quota remaining' })).toHaveAttribute('aria-valuenow', '64');
    expect(container.querySelector('[data-provider="claude"]')).toBeInTheDocument();
    expect(screen.getByText('Working on tests')).toBeInTheDocument();
    expect(screen.getByText('Recent merges')).toBeInTheDocument();
    expect(screen.getByText(/Observed 2026-11-06/)).toBeInTheDocument();
  });

  it('renders the verified-completion rate and coordination failure counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(respond(url)))));
    render(<LiveFleetBoard />);
    expect(await screen.findByText('Verified completion')).toBeInTheDocument();
    expect(await screen.findByText('75%')).toBeInTheDocument();
    expect(screen.getByText(/3 verified · 1 failed · 0 pending of 4 claims/)).toBeInTheDocument();
    expect(screen.getByText(/False completions 1 · duplicates 1 · unauthorized 0/)).toBeInTheDocument();
  });

  it('shows an honest empty state when the metric source is degraded', async () => {
    const degraded = { ...verified, sourceState: 'degraded', truncated: true, eligible: 0, verified: 0, failed: 0, pending: 0, rate: null };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('verified-completion') ? degraded : respond(url)))));
    render(<LiveFleetBoard />);
    expect(await screen.findByText(/Source degraded · ledger tail clipped/)).toBeInTheDocument();
    expect(screen.getByText('No completion claims in window.')).toBeInTheDocument();
  });

  it('polls again and replaces a missing percentage with a real reading', async () => {
    let percentage: number | null = null;
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/lanes') ? lanes(percentage) : activity)));
    vi.stubGlobal('fetch', fetcher);
    render(<LiveFleetBoard />);
    expect(await screen.findByText('Quota unknown')).toBeInTheDocument();
    percentage = 25;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 4100)); });
    await waitFor(() => expect(screen.getByRole('meter', { name: 'claude quota remaining' })).toHaveAttribute('aria-valuenow', '25'));
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/lanes')).length).toBeGreaterThanOrEqual(2);
  });
});
