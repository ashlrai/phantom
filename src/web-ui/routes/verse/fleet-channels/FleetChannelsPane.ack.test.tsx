import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetChannelsPane } from './FleetChannelsPane.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const openPane = vi.fn();
const props = { visible: true, host: { openPane } } as unknown as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows per-channel counts of messages still waiting for a leader pass', async () => {
  // The fixture's leader is 60 s old at 05:00Z: the newest pass ran at 04:59Z (00:59 ET).
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fleetRunsFixture({
    inbox: [
      { at: '2026-10-31 01:03', source: 'Telegram', text: 'fake telegram order' },
      { at: '2026-10-31 00:47', source: 'desktop app', text: 'fake desktop order' },
    ],
  }))));
  render(<FleetChannelsPane {...props} />);
  const rows = within(await screen.findByRole('list', { name: 'Channels' })).getAllByRole('listitem');
  const telegram = rows.find(row => row.textContent?.includes('Telegram'))!;
  expect(within(telegram).getByTestId('channel-ack')).toHaveTextContent(/^1 waiting for a leader pass$/);
  const desktop = rows.find(row => row.textContent?.includes('Desktop app'))!;
  expect(within(desktop).getByTestId('channel-ack')).toHaveTextContent(/^All 1 seen by a leader$/);
  const email = rows.find(row => row.textContent?.includes('Email'))!;
  expect(within(email).queryByTestId('channel-ack')).toBeNull();
});
