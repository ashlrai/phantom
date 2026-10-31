import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { takeRequestedInboxChannel } from '../fleet-inbox/inbox-source-request.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetChannelsPane } from './FleetChannelsPane.js';

afterEach(() => { cleanup(); evictAll(); takeRequestedInboxChannel(); vi.unstubAllGlobals(); });

it('requests the selected channel before opening the inbox', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fleetRunsFixture({ inbox: [
    { at: '2026-10-31T04:59:00Z', source: 'Telegram', text: 'fake message' },
  ] }))));
  const openPane = vi.fn(() => expect(takeRequestedInboxChannel()).toBe('telegram'));
  render(<FleetChannelsPane {...({ visible: true, host: { openPane } } as unknown as PaneProps)} />);
  const rows = within(await screen.findByRole('list', { name: 'Channels' })).getAllByRole('listitem');
  const telegram = rows.find(row => within(row).queryByText('Telegram'))!;
  fireEvent.click(within(telegram).getByRole('button', { name: 'Open inbox' }));
  expect(openPane).toHaveBeenCalledExactlyOnceWith('fleet-inbox');
});
