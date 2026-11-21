import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderBatch, LeaderBetsReport } from '../../../../core/fleet/leader-batches.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LeaderBetsCard, LeaderBetsCardView } from './LeaderBetsCard.js';

const batch = (over: Partial<LeaderBatch> = {}): LeaderBatch => ({
  batch: 'N21I', at: '2026-11-19T11:00:00.000Z',
  bets: [
    { id: 'RQ-ONEN21IQ8', stage: 'merged', reason: null, ended_rule: null, url: 'https://github.com/ashlrai/phantom/pull/12', at: null },
    { id: 'RQ-TWON21IQ8', stage: 'empty', reason: 'already on main', ended_rule: null, url: null, at: null },
    { id: 'RQ-THREEN21IQ8', stage: 'running', reason: null, ended_rule: null, url: 'javascript:alert(1)', at: null },
  ],
  counts: { queued: 0, running: 1, pr_open: 0, merged: 1, empty: 1, ended: 0 }, judged: 2, hit_rate: 0.5, ...over,
});
const report = (batches: LeaderBatch[], known = true): LeaderBetsReport =>
  ({ schema: 'fleet.leader-bets.v1', version: 1, window_hours: 24, known, queue_known: true, batches, summary: '' });

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('LeaderBetsCard', () => {
  it('shows the latest batch, its hit rate and each bet one tap away', () => {
    render(<LeaderBetsCardView report={report([batch(), batch({ batch: 'N20K' })])} />);
    const card = screen.getByRole('region', { name: 'Leader bets' });
    expect(within(card).getByText('Batch N21I')).toBeTruthy();
    expect(within(card).queryByText('Batch N20K')).toBeNull();
    expect(within(card).getByText('Hit rate 50%: 1 of 2 judged merged')).toBeTruthy();
    expect(within(card).getByText('1 merged · 1 running · 1 empty')).toBeTruthy();
    expect(within(card).getByText(/RQ-TWON21IQ8: Empty \(already on main\)/)).toBeTruthy();
    // Only a github.com pull request URL becomes a link.
    expect(within(card).getAllByRole('link')).toHaveLength(1);
  });

  it('says unknown, never 0%, when nothing is judged yet', () => {
    render(<LeaderBetsCardView report={report([batch({ hit_rate: null, judged: 0, counts: { queued: 3, running: 0, pr_open: 0, merged: 0, empty: 0, ended: 0 }, bets: [] })])} />);
    expect(screen.getByText('Hit rate unknown: nothing judged yet')).toBeTruthy();
    expect(screen.queryByText(/0%/)).toBeNull();
  });

  it('explains an empty window and an unreadable ledger in plain words', () => {
    const { rerender } = render(<LeaderBetsCardView report={report([])} />);
    expect(screen.getByText('No leader bets in the last day.')).toBeTruthy();
    rerender(<LeaderBetsCardView report={report([], false)} />);
    expect(screen.getByText(/unknown: the job metrics file could not be read/)).toBeTruthy();
  });

  it('loads the report from the same API as phm bets', async () => {
    stubSurfaceFetch({ routes: { '/api/fleet/leader-bets': report([batch()]) } });
    render(<LeaderBetsCard visible />);
    await waitFor(() => expect(screen.getByText('Batch N21I')).toBeTruthy());
  });

  it('stays away, with no error text, when the hub has no such route', async () => {
    stubSurfaceFetch({ routes: { '/api/fleet/leader-bets': null } });
    const { container } = render(<LeaderBetsCard visible />);
    await waitFor(() => expect(screen.queryByText('Loading leader bets…')).toBeNull());
    expect(container.textContent).toBe('');
  });
});
