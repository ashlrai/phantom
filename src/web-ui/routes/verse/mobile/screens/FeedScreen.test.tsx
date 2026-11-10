/**
 * The Feed on the phone: the desktop model's stream, newest first, narrowed
 * by chips; empty and failed states; in remote mode the sources the gateway
 * does not allow are not asked for and one footnote says so.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { activityResponse, activityState, json, needsItem, renderMobile, stubFetch } from '../mobile.test-support.js';
import { FeedScreen } from './FeedScreen.js';

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const thread = { messages: [{ id: 'm1', from: 'leader', text: 'Leader says hello', at: iso(30) }] };
const runs = { merged: [], events: [{ at: iso(5), kind: 'note', text: 'Fleet event newest' }] };
const alertActivity = activityState(activityResponse({ needsYou: [needsItem({ id: 'a1', title: 'Approve the PR', since: iso(10) })] }));

afterEach(() => {
  evictAll();
  document.head.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('FeedScreen', () => {
  it('renders items newest first and a chip narrows them', async () => {
    stubFetch({ 'GET /api/verse/leader/thread': thread, 'GET /api/verse/fleet/runs': runs });
    renderMobile(<FeedScreen />, { activity: alertActivity });
    const newest = await screen.findByText('Fleet event newest');
    const alert = screen.getByText('Approve the PR');
    const leader = screen.getByText('Leader says hello');
    expect(newest.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(leader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(screen.getByText('Approve the PR')).toBeInTheDocument();
    expect(screen.queryByText('Leader says hello')).not.toBeInTheDocument();
  });

  it('says "Nothing new yet." when every source is empty', async () => {
    stubFetch({ 'GET /api/verse/leader/thread': { messages: [] }, 'GET /api/verse/fleet/runs': {} });
    renderMobile(<FeedScreen />, { activity: activityState(activityResponse()) });
    expect(await screen.findByText('Nothing new yet.')).toBeInTheDocument();
  });

  it('shows an error with retry when every source fails', async () => {
    stubFetch({
      'GET /api/verse/leader/thread': () => json({ error: 'boom' }, 500),
      'GET /api/verse/fleet/runs': () => json({ error: 'boom' }, 500),
      'GET /api/verse/comms/owner-thread': () => json({ error: 'boom' }, 500),
    });
    renderMobile(<FeedScreen />, { activity: activityState(null, 'unavailable') });
    expect(await screen.findByText('Couldn’t load the feed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });

  it('remote mode skips forbidden sources quietly and shows one footnote', async () => {
    document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
    const { calls } = stubFetch({
      'GET /api/verse/leader/thread': thread,
      'GET /api/verse/fleet/runs': runs,
      'GET /api/verse/comms/owner-thread': () => json({ error: 'forbidden' }, 403),
      'GET /api/verse/ops/self-update': () => json({ error: 'forbidden' }, 403),
    });
    renderMobile(<FeedScreen />, { activity: alertActivity });
    expect(await screen.findByText('Leader says hello')).toBeInTheDocument();
    expect(screen.getByText(/not available on the phone/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn’t load|unavailable\b.*feed/i)).not.toBeInTheDocument();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((c) => c.url.includes('owner-thread') || c.url.includes('self-update'))).toBe(false);
  });
});
