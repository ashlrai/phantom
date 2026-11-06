import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot, refetchQuery } from '../../../../data/cache.js';
import { fleetLive } from '../../command/fixtures.test-support.js';
import { controlSnapshot } from '../../sections/section-fixtures.test-support.js';
import { homeRunsQuery } from '../home-runs-query.js';
import { json, renderMobile, stubFetch } from '../mobile.test-support.js';
import { HomeBody } from './HomeBody.js';

const now = Date.parse('2026-10-31T04:24:00Z');
const snapshot = {
  v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], mergesLastHour: { count: 0 },
  codexPersonal: { usedPct: 92, resetsAt: null }, generatedAt: '2026-10-31T04:20:00Z',
  leaders: [{ label: 'Leader', ageSeconds: 300 }],
  inbox: [{ at: '2026-10-31 00:16', source: 'phone', text: 'Steer from the phone' }],
};

afterEach(() => {
  evictAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(runs: unknown) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  stubFetch({
    'GET /api/verse/control': controlSnapshot(), 'GET /api/verse/fleet/live': fleetLive('live', now),
    'GET /api/verse/bootstrap': { seats: [] }, 'GET /api/verse/fleet/runs': runs, 'GET /api/verse/cloud': {},
  });
  return renderMobile(<HomeBody />);
}

describe('Home last order', () => {
  it('shows the newest order beside its acknowledgment and opens Inbox', async () => {
    const { context } = setup(snapshot);
    const row = await screen.findByRole('button', { name: /Your last order/ });
    expect(within(row).getByText('phone · 8 m ago: Steer from the phone')).toBeTruthy();
    expect(within(row).getByText('Waiting · next pass due in about 6 min')).toBeTruthy();
    expect(screen.getByText('Personal Codex').closest('section')).toBe(row.closest('section'));
    fireEvent.click(row);
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'inbox' });
  });

  it('updates the badge when a newer leader pass appears', async () => {
    let current = snapshot;
    setup(() => current);
    expect(await screen.findByText(/Waiting · next pass/)).toBeTruthy();
    current = { ...snapshot, leaders: [{ label: 'Leader', ageSeconds: 60 }] };
    await refetchQuery(homeRunsQuery.key, () => homeRunsQuery.fetch(), true);
    expect(await screen.findByText(/Seen by leaders/)).toBeTruthy();
  });

  it.each([{ ...snapshot, inbox: [] }, json({}, 404)])('omits the row for an empty inbox or absent route', async (runs) => {
    setup(runs);
    await waitFor(() => expect(getQuerySnapshot(homeRunsQuery.key).status).toBe('success'));
    expect(screen.queryByText('Your last order')).toBeNull();
  });
});
