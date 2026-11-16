/** RQ-PHX-RECHECKHISTSTRIP330 — strip renders from a mocked fetch. Fake hosts only. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { RecheckHistoryStrip } from './RecheckHistoryStrip.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

const mk = (minsAgo: number, overall: string, bridge: string) => {
  const asOf = new Date(Date.now() - minsAgo * 60_000).toISOString();
  const s = (state: string) => ({ state, asOf });
  return { asOf, overall, sections: { runtime: s('VERIFIED'), claims: s('VERIFIED'), bridge: s(bridge), task: s('VERIFIED'), host: 'host-a.example' } };
};

it('renders the held line and changes', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/verse/fleet/recheck?history=')) {
      return json({ history: { skipped: 0, missing: false, rows: [mk(5, 'BLOCKED', 'BLOCKED'), mk(125, 'UNKNOWN', 'UNKNOWN')] } });
    }
    return json({}, 404);
  }));
  render(<RecheckHistoryStrip />);
  await waitFor(() => expect(screen.getByText(/^BLOCKED for 5m/)).toBeInTheDocument());
  expect(screen.getByRole('region', { name: 'Recheck history' })).toBeInTheDocument();
  expect(screen.getByText(/bridge UNKNOWN → BLOCKED, overall UNKNOWN → BLOCKED/)).toBeInTheDocument();
});

it('renders nothing on 404', async () => {
  const fetchMock = vi.fn(async () => json({}, 404));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<RecheckHistoryStrip />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await waitFor(() => expect(container.querySelector('section')).toBeNull());
});
