import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LeaderOfficeStrip } from './LeaderOfficeStrip.js';
import { narrowLeaderOffice } from './leader-office-model.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const view = {
  roles: [{ id: 'engineering', title: 'Engineering', owner: 'engineering', lane: 'work' }],
  priorities: [{ rq: 'RQ-LEADER-CEO-1', owner: 'engineering', status: 'assigned', due: '2026-11-10', outcome: null }],
  latestReply: 'Routed to Engineering.',
};

describe('Leader office strip', () => {
  it('shows priorities, org and the latest reply', () => {
    render(<LeaderOfficeStrip view={view} />);
    const office = screen.getByRole('region', { name: 'Leader office' });
    expect(within(office).getByText(/RQ-LEADER-CEO-1/)).toBeInTheDocument();
    expect(within(office).getByText(/Engineering · engineering · work/)).toBeInTheDocument();
    expect(within(office).getByText(/Routed to Engineering/)).toBeInTheDocument();
  });

  it('hides an unrecognized office payload', () => {
    expect(narrowLeaderOffice({ org: { roles: [] } })).toBeNull();
    render(<LeaderOfficeStrip view={null} />);
    expect(screen.getByText('Org and priorities unavailable.')).toBeInTheDocument();
  });
});

describe('Leader pane office', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());

  it('renders the office next to the conversation', async () => {
    stubSurfaceFetch({ routes: {
      '/api/verse/leader/office': {
        org: { roles: view.roles },
        priorities: view.priorities,
        outbox: [{ text: view.latestReply }],
      },
      '/api/verse/leader/thread': { messages: [] },
      '/api/verse/leader/directives': { directives: [] },
      '/api/verse/fleet/runs': { inbox: [] },
    } });
    render(<LeaderThreadPane visible />);
    const office = await screen.findByRole('region', { name: 'Leader office' });
    expect(within(office).getByText(/RQ-LEADER-CEO-1/)).toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Conversation with the Leader' })).toBeInTheDocument();
  });
});
