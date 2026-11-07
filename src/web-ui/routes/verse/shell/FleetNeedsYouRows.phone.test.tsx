import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { getVerseUiState, openVerseNeedsYou, resetVerseUi, VERSE_ANCHOR_EVENT } from '../verse-ui-store.js';
import { FleetNeedsYouRows, type FleetNeedsYouReport } from './FleetNeedsYouRows.js';
import { phonePendingQuery } from './phone-pending-query.js';

const pending = { v: 1, generatedAt: '2026-11-01T04:12:00Z', gateway: 'running', approvals: [
  { id: '12345678-abcd-1234-abcd-123456789abc', label: 'Phone', email: 'mason@example.com', subject: 'subject' },
] };
function setup(status = 200) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/verse/fleet/control/remote-pending' && status === 200
    ? Response.json(pending) : new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const reports: FleetNeedsYouReport[] = [];
  render(<FleetNeedsYouRows split="all" nowMs={0} onResult={report => reports.push(report)} />);
  return { fetcher, reports };
}
beforeEach(() => { localStorage.clear(); evictAll(); resetVerseUi(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('reports the phone and opens Connection at the existing Settings anchor', async () => {
  act(() => openVerseNeedsYou({ split: 'all' }));
  const anchors = vi.fn();
  window.addEventListener(VERSE_ANCHOR_EVENT, anchors);
  try {
    const { reports } = setup();
    expect(await screen.findByText('Phone waiting for your approval')).toBeInTheDocument();
    expect(screen.getByText('Phone · mason@example.com')).toBeInTheDocument();
    expect(screen.getByText('Next: Approve or deny it in Settings › Connection')).toBeInTheDocument();
    await waitFor(() => expect(reports.at(-1)?.items).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Open Connection' }));
    expect(getVerseUiState()).toMatchObject({ overlay: null, section: 'settings' });
    expect(anchors.mock.calls[0]?.[0].detail).toEqual({ section: 'settings', anchor: 'fleet-sources' });
  } finally { window.removeEventListener(VERSE_ANCHOR_EVENT, anchors); }
});

it('contributes nothing when the endpoint is absent', async () => {
  const { fetcher, reports } = setup(404);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/verse/fleet/control/remote-pending', expect.anything()));
  await waitFor(() => expect(reports.at(-1)?.items).toEqual([]));
  expect(await phonePendingQuery.fetch()).toEqual({ kind: 'notInBuild' });
  expect(screen.queryByText('Phone waiting for your approval')).not.toBeInTheDocument();
});

it('removes an approval when a subsequent read no longer lists it', async () => {
  setup();
  await screen.findByText('Phone waiting for your approval');
  await act(async () => { await refetchQuery(phonePendingQuery.key, async () => ({ ...pending, approvals: [] }), true); });
  expect(screen.queryByText('Phone waiting for your approval')).not.toBeInTheDocument();
});
