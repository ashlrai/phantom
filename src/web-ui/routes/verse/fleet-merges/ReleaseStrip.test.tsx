import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot, refetchQuery } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { ReleaseStrip } from './ReleaseStrip.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const fixture = () => ({ v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', repos: [{
  repo: 'ashlrai/phantom', path: '/phantom', notes: [], pr: {
    number: 1479, title: 'release', url: 'https://github.com/ashlrai/phantom/pull/1479', version: '3.30.0',
    openedAt: '2026-10-30T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z', mergeable: null,
    checks: [{ name: 'Dependency audit (root + Raycast)', state: 'fail', url: 'https://github.com/ashlrai/phantom/actions/runs/1' }],
    failing: ['Dependency audit (root + Raycast)'], pending: 0, blocked: true, summary: '3.30.0 blocked by Dependency audit (root + Raycast)',
  },
}] });
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); });

it('renders the blocker, PR link and check disclosure', async () => {
  vi.mocked(apiGet).mockResolvedValue(fixture());
  render(<ReleaseStrip visible />);
  expect(await screen.findByText(/3\.30\.0 blocked by Dependency audit/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open PR' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1479');
  fireEvent.click(screen.getByText('Checks (1)'));
  const row = within(screen.getByRole('list')).getByRole('listitem');
  expect(row).toHaveTextContent('Dependency audit (root + Raycast) · fail');
  expect(within(row).getByRole('link')).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/actions/runs/1');
});

it('hides a missing route', async () => {
  vi.mocked(apiGet).mockRejectedValue(new ApiError('missing', 404, '/api/verse/release-pr'));
  const view = render(<ReleaseStrip visible />);
  await vi.waitFor(() => expect(getQuerySnapshot('verse-release-pr').data).toEqual({ kind: 'notInBuild' }));
  expect(view.container).toBeEmptyDOMElement();
});

it('shows unavailability on an initial fetch error', async () => {
  vi.mocked(apiGet).mockRejectedValue(new Error('offline'));
  render(<ReleaseStrip visible />);
  expect(await screen.findByText('Release train unavailable')).toBeInTheDocument();
});

it('shows unavailability on refresh failures and rejects malformed responses', async () => {
  vi.mocked(apiGet).mockResolvedValue(fixture());
  render(<ReleaseStrip visible />);
  await screen.findByText(/3\.30\.0 blocked/);
  await act(async () => { await refetchQuery('verse-release-pr', async () => { throw new Error('offline'); }, true); });
  expect(screen.getByText('Release train unavailable')).toBeInTheDocument();
  vi.mocked(apiGet).mockResolvedValue({ v: 1, repos: [] });
  const { releasePrQuery } = await import('../fleet/release-pr-query.js');
  await expect(releasePrQuery.fetch()).rejects.toThrow('Invalid release PR response');
});

it('polls every minute only while visible', async () => {
  vi.useFakeTimers(); vi.mocked(apiGet).mockResolvedValue(fixture());
  const view = render(<ReleaseStrip visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(apiGet).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<ReleaseStrip visible />); });
  expect(apiGet).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(apiGet).toHaveBeenCalledTimes(2);
  view.rerender(<ReleaseStrip visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(apiGet).toHaveBeenCalledTimes(2);
});
