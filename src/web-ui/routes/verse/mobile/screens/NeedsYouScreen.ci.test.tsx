import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { markResolved, resetResolvedForTest } from '../../shell/resolved-store.js';
import { activityResponse, activityState, renderMobile, stubFetch } from '../mobile.test-support.js';
import { NeedsYouScreen, resetHiddenForTest } from './NeedsYouScreen.js';

const activity = activityState(activityResponse());
const facts = () => ({
  v: 1, generatedAt: new Date().toISOString(), repo: 'ashlrai/phantom', windowHours: 24, available: true, reason: null,
  total: 20, byEvent: { pull_request: 17, push: 3, schedule: 0, merge_group: 0, workflow_dispatch: 0, other: 0 },
  byWorkflow: [], failures: { total: 8, bindArtifact: 5, code: 2, unclassified: 1 }, daily: null, recent: [],
});
const lane = { lane: 'codex-personal', target: 0, floor: 0, ceiling: 8, held: true,
  heldReason: 'usage limit', heldUntil: null, lastChange: null, changedBy: 'autobackoff' };

afterEach(() => {
  evictAll();
  resetResolvedForTest();
  resetHiddenForTest();
  vi.unstubAllGlobals();
});

it('renders the CI summary after holds and supports the normal filters and hide control', async () => {
  const fetch = stubFetch({
    'GET /api/verse/fleet/ci-runs': facts(),
    'GET /api/verse/fleet/control/holds': { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [lane] },
  });
  renderMobile(<NeedsYouScreen />, { activity });
  const title = await screen.findByRole('heading', { name: 'CI ran 17 times on PRs today' });
  const card = title.closest('article')!;
  expect(within(card).getByText(/8 reds: 5 rebase artifacts \(not code\), 2 code/)).toHaveTextContent('Order: once a day. On the Mac: ashlr fleet ci-plan --patch | git apply');
  expect(screen.getByText('codex-personal is held').compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(fetch.calls.some((call) => call.url === '/api/verse/fleet/ci-runs?hours=24')).toBe(true);
  expect(screen.queryByText('All clear')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Chats 0/ }));
  expect(screen.queryByRole('heading', { name: /CI ran/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Fleet 1/ }));
  fireEvent.click(screen.getByRole('button', { name: /Hide on this phone: CI ran/ }));
  expect(screen.queryByRole('heading', { name: /CI ran/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Undo hide: CI ran/ }));
  expect(screen.getByRole('heading', { name: /CI ran/ })).toBeInTheDocument();
}, 20_000);

it('honors resolved IDs', async () => {
  markResolved('fleet:owner-hold:ci-runs');
  const fetch = stubFetch({ 'GET /api/verse/fleet/ci-runs': facts() });
  renderMobile(<NeedsYouScreen />, { activity });
  await waitFor(() => expect(fetch.calls.some((call) => call.url.includes('/fleet/ci-runs'))).toBe(true));
  expect(screen.queryByRole('heading', { name: /CI ran/ })).not.toBeInTheDocument();
});

it.each([404, 403])('quietly omits the card on HTTP %i', async (status) => {
  const fetch = stubFetch({ 'GET /api/verse/fleet/ci-runs': () => new Response(null, { status }) });
  renderMobile(<NeedsYouScreen />, { activity });
  await waitFor(() => expect(fetch.calls.some((call) => call.url.includes('/fleet/ci-runs'))).toBe(true));
  expect(screen.queryByRole('heading', { name: /CI ran/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/CI facts not available/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Couldn’t load Needs you/)).not.toBeInTheDocument();
});

it('quietly omits malformed responses and network failures', async () => {
  const { needsCiQuery } = await import('../needs-ci-query.js');
  stubFetch({ 'GET /api/verse/fleet/ci-runs': { ...facts(), failures: { total: '8', bindArtifact: 5, code: 2 } } });
  expect(await needsCiQuery.fetch()).toBeUndefined();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
  expect(await needsCiQuery.fetch()).toBeUndefined();
});
