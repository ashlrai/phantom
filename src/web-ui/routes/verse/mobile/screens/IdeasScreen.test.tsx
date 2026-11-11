/**
 * The Ideas screen on the phone: the ranked backlog through the desktop
 * ideas-model (rankIdeas, groupByRepo, ideasHeadline, sourceCounts), the
 * linked goal label from idea-goal-link, the queued badge joined from
 * pending proposals' workItemId, the unavailable state and Back to More.
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { json, renderMobile, stubFetch } from '../mobile.test-support.js';
import { IdeasScreen } from './IdeasScreen.js';

const backlog = {
  items: [
    { id: 'idea-low', title: 'Document the queue tiers', repo: 'ashlrai/phantom', score: 9, source: 'doc' },
    { id: 'idea-top', title: 'Fix the flaky snapshot test', repo: 'ashlrai/phantom', score: 42, source: 'lint' },
    { id: 'idea-goal', title: 'Ship the new goals view', repo: 'ashlrai/phantom', score: 30, source: 'goal-drift', goalId: 'g1' },
  ],
};

const goals = [
  { id: 'g1', objective: 'Merge ten PRs an hour', status: 'active', milestones: [], progress: { fractionDone: 0, counts: {}, nextActionableId: null } },
];

const inbox = {
  pending: 2,
  total: 2,
  truncated: false,
  filters: { status: 'pending', since: null, limit: null },
  proposals: [
    { id: 'p1', workItemId: 'idea-top' },
    { id: 'p2', workItemId: 'idea-elsewhere' },
  ],
};

function stubAll() {
  return stubFetch({
    'GET /api/backlog': backlog,
    'GET /api/goals': goals,
    'GET /api/inbox': inbox,
  });
}

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('IdeasScreen', () => {
  it('renders ranked ideas through the desktop model, grouped by repo', async () => {
    stubAll();
    renderMobile(<IdeasScreen />);
    const top = await screen.findByText('Fix the flaky snapshot test');
    expect(screen.getByText('3 candidates across 1 repo. Top: Fix the flaky snapshot test')).toBeInTheDocument();
    expect(screen.getByText('doc 1 · goal-drift 1 · lint 1')).toBeInTheDocument();
    const low = screen.getByText('Document the queue tiers');
    expect(top.compareDocumentPosition(low) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Ship the new goals view')).toBeInTheDocument();
    expect(screen.getByText('score 42 · lint')).toBeInTheDocument();
  });

  it('shows the linked goal label and the queued badge', async () => {
    stubAll();
    renderMobile(<IdeasScreen />);
    expect(await screen.findByText('for: Merge ten PRs an hour')).toBeInTheDocument();
    expect(screen.getAllByText('Queued')).toHaveLength(1);
    expect(screen.getByText('Fix the flaky snapshot test').closest('div')?.textContent).toContain('Queued');
    expect(screen.getByText('Ship the new goals view').closest('div')?.textContent).not.toContain('Queued');
  });

  it('shows the unavailable state when the backlog read fails', async () => {
    stubFetch({ 'GET /api/backlog': () => json({ error: 'boom' }, 500) });
    renderMobile(<IdeasScreen />);
    expect(await screen.findByText('Couldn’t load ideas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('Back goes to More', async () => {
    stubAll();
    const { context } = renderMobile(<IdeasScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'more' });
  });
});
