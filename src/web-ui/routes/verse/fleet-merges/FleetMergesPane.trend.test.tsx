import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';
import { resetMergeHistory } from './merges-history-store.js';

const props = { visible: true } as PaneProps;
const fixture = (generatedAt: string, count: number) => ({
  generatedAt, mergesLastHour: { count, items: [] }, publishesLastHour: [], lanes: [], sources: { merges: 'healthy' },
});

beforeEach(() => { evictAll(); resetMergeHistory(); });
afterEach(() => { cleanup(); resetMergeHistory(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows no trend for a single reading', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture('2026-01-01T00:00:00Z', 12))));
  render(<FleetMergesPane {...props} />);
  await screen.findByText('12 merged in the last hour · 0 publishes waiting');
  expect(screen.queryByRole('img', { name: /Merged per hour trend/ })).not.toBeInTheDocument();
});

it('shows throughput over the observed time after a second reading', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture('2026-01-01T00:00:00Z', 12))));
  render(<FleetMergesPane {...props} />);
  await screen.findByText('12 merged in the last hour · 0 publishes waiting');
  clock.mockReturnValue(90 * 60_000);
  await act(async () => { await refetchQuery('verse-fleet-runs', async () => fixture('2026-01-01T01:30:00Z', 3), true); });
  expect(screen.getByRole('img', { name: 'Merged per hour trend: 12 then 3 over 90 minutes' })).toHaveTextContent('█▃ 12 → 3 merged/h over the last 90 min');
});
