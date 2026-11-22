import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompactLeaderBrief } from '../../../../core/fleet/leader-compact-brief.js';
import { FleetNowPanel } from '../../../../../desktop/src/FleetNowPanel.js';
import { evictAll } from '../../../data/cache.js';

const brief = {
  schema: 'leader.compact-brief.v1', state: 'ready', at: '2026-11-21T12:00:00Z', sources: { ledger: 'healthy' },
  headline: 'The fleet is working.', windowHours: 2, emptyWindowHours: 24,
  lanes: [{ lane: 'work', running: 2, target: 4, queued: 3, held: false, emptyRate: null }],
  pools: [{ pool: 'work', usedPct: 40, hoursToReset: 2, burnPerHour: 2, safeBurn: 4, verdict: 'ok' }],
  main: [{ repo: 'phantom', state: 'green', stale: false }], families: [], attention: [], liveAt: null,
  medianOpenToMergeSeconds: null, stopped: [], omitted: 0, hostLoad: { state: 'unknown', families: [], omitted: 0 },
  mergedPrs: Array.from({ length: 6 }, (_, i) => ({ repo: 'ashlrai/phantom', number: i + 1, title: 'Better view', url: `https://github.com/ashlrai/phantom/pull/${i + 1}`, at: '2026-11-21T12:00:00Z' })),
} satisfies CompactLeaderBrief;
const serve = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('renders the shared headline, lanes, spend, main and five merges', async () => {
  serve(brief); render(<FleetNowPanel />);
  expect(await screen.findByText(brief.headline)).toBeInTheDocument();
  expect(screen.getByText('work: 2 running / 4 target · 3 queued')).toBeInTheDocument();
  expect(screen.getByRole('meter')).toHaveAttribute('value', '2');
  expect(screen.getByText('work: 40% used · resets in 2.0 h · on pace')).toBeInTheDocument();
  expect(screen.getByText('phantom: green')).toBeInTheDocument();
  expect(screen.getAllByRole('link')).toHaveLength(5);
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/verse/fleet/runs/leader-brief');
});
it('renders an empty brief', async () => {
  serve({ schema: brief.schema, state: 'no data' }); render(<FleetNowPanel />);
  expect(await screen.findByText('No fleet data yet.')).toBeInTheDocument();
});
it('explains each empty section and a failed first read', async () => {
  serve({ ...brief, lanes: [], pools: [], main: [], mergedPrs: [] });
  const view = render(<FleetNowPanel />);
  expect(await screen.findByText('Lane readings are missing.')).toBeInTheDocument();
  for (const text of ['Pool readings are missing.', 'Main health readings are missing.', 'No merged PRs recorded.']) expect(screen.getByText(text)).toBeInTheDocument();
  view.unmount(); evictAll(); vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  render(<FleetNowPanel />);
  expect(await screen.findByText('Fleet brief could not be read.')).toBeInTheDocument();
});
it('explains missing readings and old main health without inventing zero', async () => {
  serve({ ...brief, lanes: [{ ...brief.lanes[0], running: null, target: null, queued: null }], pools: [{ ...brief.pools[0], usedPct: null, hoursToReset: null, verdict: 'unknown' }], main: [{ ...brief.main[0], stale: true }], mergedPrs: undefined });
  render(<FleetNowPanel />);
  expect(await screen.findByText('work: unknown running / unknown target · unknown queued')).toBeInTheDocument();
  expect(screen.queryByRole('meter')).toBeNull();
  for (const text of ['work: spend unknown · reset time unknown · pace unknown', 'phantom: unknown; reading is old', 'Recent merge readings are missing.']) expect(screen.getByText(text)).toBeInTheDocument();
});
it('refreshes every thirty seconds and keeps a failed refresh visibly old', async () => {
  vi.useFakeTimers(); serve(brief); const view = render(<FleetNowPanel />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/Could not refresh; showing the last reading/)).toBeInTheDocument();
  view.rerender(<FleetNowPanel visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
});
