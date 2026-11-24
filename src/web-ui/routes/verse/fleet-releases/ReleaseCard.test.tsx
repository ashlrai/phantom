import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { ReleaseCard } from './ReleaseCard.js';

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('renders the shared release fields and opens its log with one action', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:30:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ release: {
    latestPublishedTag: 'v1.2.3', publishedAt: '2026-11-10T12:00:00Z', signedAssets: false, updaterHttp: 200, recordedAt: '2026-11-10T12:05:00Z', mergedPrsSinceTag: 42,
    nextCandidate: { version: '1.2.4', eta: '2026-11-10T13:00:00Z', cadenceMinutes: 60 }, autorun: { rc: 12, reason: 'Reason: signature missing', log: 'START v1.2.4\nReason: signature missing' },
  } }))));
  render(<ReleaseCard visible />);
  expect(await screen.findByText(/Published: v1.2.3/)).toBeTruthy();
  expect(screen.getByText(/Signed assets: missing · Updater HTTP: 200/)).toBeTruthy();
  expect(screen.getByText(/Merged PRs since tag: 42/)).toBeTruthy();
  expect(screen.getByText(/Next: 1.2.4/)).toHaveTextContent('(due)');
  expect(screen.getByText(/Autorun rc: 12/)).toHaveTextContent('Reason: signature missing');
  expect(screen.getAllByRole('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'See log' }));
  expect(screen.getByText(/START v1.2.4/)).toBeTruthy();
});
it('waits for an older-server response before showing the empty-log state', async () => {
  let resolveResponse!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve; })));
  render(<ReleaseCard visible />);
  fireEvent.click(screen.getByRole('button', { name: 'See log' }));
  expect(screen.getByText('Loading release log…')).toBeTruthy();
  resolveResponse(new Response('{}'));
  expect(await screen.findByText('Log unknown: no local log was recorded.')).toBeTruthy();
  expect(screen.getByText('Published: unknown · time unknown')).toBeTruthy();
});
it('shows a fetch error instead of claiming that no log was recorded', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<ReleaseCard visible />);
  fireEvent.click(screen.getByRole('button', { name: 'See log' }));
  expect(await screen.findByText('Log unavailable: release status could not be fetched.')).toBeTruthy();
});
