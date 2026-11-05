/**
 * routes/verse/fleet/FleetCards.runsdir.test.tsx — the lanes strip's
 * dispatchd fallback: when the live API reports the stale-standing reason
 * (slots 0, "capacity unknown"), a fresh /api/verse/fleet/runs read supplies
 * the chip's counts and the strip names the source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { fleetLive } from '../command/fixtures.test-support.js';
import { fleetRunsFixture } from './fleet-runs-fixtures.test-support.js';
import { resetLaneHistory } from './lane-history-store.js';
import { STALE_STANDING_LANES } from './lane-runsdir-fallback.js';
import { LanesStrip } from './FleetCards.js';

const MIN = 60_000;

function staleLive(now: number) {
  const live = fleetLive('live', now);
  live.lanes = [{ lane: 'devin-cli', slots: 0, busy: 0, capReason: STALE_STANDING_LANES }];
  return live;
}

const runsWith = (now: number, lanes?: FleetRunsV1['lanes']) => fleetRunsFixture({
  generatedAt: new Date(now - 5_000).toISOString(),
  lastTick: new Date(now - MIN).toISOString(),
  ...(lanes ? { lanes } : {}),
});

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); evictAll(); resetLaneHistory(); });

describe('LanesStrip dispatchd fallback', () => {
  it('shows dispatchd counts and names the source when the standing tick is stale', async () => {
    const now = Date.now();
    stubSurfaceFetch({
      kind: 'live', now,
      routes: {
        '/api/verse/fleet/runs': runsWith(now, [
          { lane: 'devin', running: 7, target: 10, queued: 712, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
        ]),
      },
    });
    render(<LanesStrip live={staleLive(now)} />);
    const lanes = await screen.findByRole('list', { name: 'Lanes: busy of slots' });
    const devin = within(lanes).getByText('Devin CLI').closest('li')!;
    expect(devin).toHaveTextContent('7 of 10 · 712 queued');
    expect(screen.queryByText('capacity unknown')).not.toBeInTheDocument();
    const notes = screen.getByRole('list', { name: 'Why lanes are limited' });
    expect(notes).toHaveTextContent(/Lane counts come from dispatchd, read \d+m ago/);
    expect(notes).not.toHaveTextContent('unobserved');
  });

  it('keeps capacity unknown and the unobserved note when the runs read fails', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/fleet/runs': null } });
    render(<LanesStrip live={staleLive(now)} />);
    const lanes = await screen.findByRole('list', { name: 'Lanes: busy of slots' });
    const devin = within(lanes).getByText('Devin CLI').closest('li')!;
    expect(devin).toHaveTextContent('capacity unknown');
    expect(screen.getByRole('list', { name: 'Why lanes are limited' })).toHaveTextContent('Lane capacity is unobserved');
  });
});
