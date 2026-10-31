import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { bootstrap, MockEventSource, session } from '../fixtures.test-support.js';
import { activityResponse, json, renderMobile, stubFetch } from './mobile.test-support.js';
import { WorkersSection } from './WorkersSection.js';
import { AgentsScreen } from './screens/AgentsScreen.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('Fleet workers', () => {
  it('shows sorted worker details, limits rows, refreshes, and collapses', async () => {
    const user = userEvent.setup();
    const workers = Array.from({ length: 22 }, (_, i) => ({ job: `RQ-FAKE-${i}`, lane: 'fake-lane', tier: 'work', ageSeconds: i * 200, repo: 'private-repo-fixture' }));
    const fetch = stubFetch({ 'GET /api/verse/fleet/runs': { workers, inbox: [{ text: 'private-inbox-fixture' }] } });
    renderMobile(<WorkersSection />);
    expect(await screen.findByText('22 running · oldest RQ-FAKE-21 1 h')).toBeInTheDocument();
    const oldest = screen.getByText('RQ-FAKE-21').closest('div');
    expect(oldest).toHaveTextContent('fake-lane · work');
    expect(oldest?.querySelector('[data-tone="bad"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show all 22 workers' })).toBeInTheDocument();
    expect(screen.queryByText('RQ-FAKE-0')).not.toBeInTheDocument();
    expect(screen.queryByText(/private-(repo|inbox)-fixture/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetch.calls.filter(call => call.url === '/api/verse/fleet/runs')).toHaveLength(2));
    await user.click(screen.getByText(/22 running/));
    expect(screen.getByText('RQ-FAKE-21')).not.toBeVisible();
  });

  it('renders nothing when the endpoint is absent', async () => {
    const fetch = stubFetch({ 'GET /api/verse/fleet/runs': json({}, 404) });
    const { container } = renderMobile(<WorkersSection />);
    await waitFor(() => expect(fetch.calls).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows an empty state and reports failures without exposing response details', async () => {
    let fail = false;
    const user = userEvent.setup();
    stubFetch({ 'GET /api/verse/fleet/runs': () => fail ? json({ error: 'private-error-fixture' }, 503) : { workers: [] } });
    renderMobile(<WorkersSection />);
    expect(await screen.findAllByText('No workers running')).toHaveLength(2);
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Couldn’t refresh workers/)).toBeInTheDocument();
    expect(screen.queryByText('private-error-fixture')).not.toBeInTheDocument();
  });

  it('keeps the agent columns alongside the workers section', async () => {
    const chat = session({ id: 'fake-chat', title: 'Fake chat', status: 'running' });
    vi.stubGlobal('EventSource', MockEventSource);
    stubFetch({
      'GET /api/verse/sessions': [chat],
      'GET /api/verse/bootstrap': bootstrap({ sessions: [chat] }),
      'GET /api/verse/activity': activityResponse(),
      'GET /api/verse/session-meta': { sessions: {} },
      'GET /api/verse/fleet/runs': { workers: [{ job: 'RQ-FAKE', lane: 'fake-lane', tier: 'mid', ageSeconds: 60 }] },
    });
    renderMobile(<AgentsScreen />);
    const chips = await screen.findByRole('group', { name: 'Show agents' });
    expect(within(chips).getByRole('button', { name: /Working/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /Needs you/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /Review/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /Done/ })).toBeInTheDocument();
    expect(await screen.findByText('RQ-FAKE')).toBeInTheDocument();
  });
});
