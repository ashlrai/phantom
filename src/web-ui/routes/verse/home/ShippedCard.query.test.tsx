import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ShippedReport } from '../../../../core/release/shipped.js';
import { evictAll, getQuerySnapshot, invalidate } from '../../../data/cache.js';
import { ShippedCard, shippedQuery } from './ShippedCard.js';

// The card caches one read per window, so the key carries the days.
const KEY = shippedQuery(7).key;

// A payload from a server older than the top line: the card falls back to the plain count.
const report = {
  schema: 'shipped.v1',
  version: 1,
  generatedAt: '2026-11-17T00:00:00.000Z',
  since: '2026-11-10T00:00:00.000Z',
  days: 7,
  source: 'ok',
  note: null,
  total: 5,
  maintenance: 0,
  areas: [{ id: 'cli', label: 'CLI', count: 5, lines: [] }],
} as unknown as ShippedReport;
let responses: Response[] = [];
const fetched: string[] = [];

function stubFetch(next: Response[]) {
  responses = [...next];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    const response = responses.shift();
    if (!response) throw new Error('unexpected shipped request');
    return response;
  }));
}

beforeEach(() => { evictAll(); fetched.length = 0; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });

describe('ShippedCard query refresh', () => {
  it('keeps the cached report and shows its last-success time after a 503', async () => {
    stubFetch([Response.json(report), new Response('{}', { status: 503 })]);
    render(<ShippedCard />);
    expect(await screen.findByText('5 changes in the last 7 days.')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();

    const lastSuccess = getQuerySnapshot<ShippedReport>(KEY).updatedAt;
    expect(lastSuccess).not.toBeNull();
    invalidate(KEY);

    const warning = await screen.findByRole('status');
    expect(warning.textContent).toContain('Refresh failed; showing the last shipped report, which may be stale.');
    expect(warning.querySelector('time')?.getAttribute('datetime')).toBe(new Date(lastSuccess!).toISOString());
    expect(screen.getByText('5 changes in the last 7 days.')).toBeTruthy();
    expect(fetched).toHaveLength(2);
    expect(fetched.every(url => url.includes('/api/verse/shipped'))).toBe(true);
    const cached = getQuerySnapshot<ShippedReport>(KEY);
    expect(cached.data).toEqual(report);
    expect(cached.updatedAt).toBe(lastSuccess);
  });

  it('shows an error state for a 503 when no report is cached', async () => {
    stubFetch([new Response('{}', { status: 503 })]);
    render(<ShippedCard />);
    expect((await screen.findByRole('status')).textContent).toBe('What shipped is unavailable right now. Try again.');
    expect(screen.queryByText('5 changes in the last 7 days.')).toBeNull();
    expect(getQuerySnapshot<ShippedReport>(KEY).data).toBeUndefined();
  });
});
