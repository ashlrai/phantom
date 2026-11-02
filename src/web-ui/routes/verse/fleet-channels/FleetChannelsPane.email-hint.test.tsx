import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { EMAIL_DROP_USAGE } from './fleet-channels-model.js';
import { FleetChannelsPane } from './FleetChannelsPane.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;

const renderWith = async (inbox: { at: string; source: string; text: string }[]) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fleetRunsFixture({ inbox }))));
  render(<FleetChannelsPane {...props} />);
  const rows = within(await screen.findByRole('list', { name: 'Channels' })).getAllByRole('listitem');
  return (label: string) => rows.find(row => within(row).queryByText(label))!;
};

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows the email drop command and drop-folder defaults on a silent email row', async () => {
  const row = await renderWith([]);
  const email = row('Email');
  const hint = within(email).getByTestId('channel-setup-hint');
  // The usage line is mirrored byte-identically from EMAIL_DROP_USAGE in src/cli/comms.ts.
  expect(EMAIL_DROP_USAGE).toBe('usage: phm comms email-drop <inboxDir> --from <address> [--from <address> ...] [--outbox <dir>] [--processed <dir>] [--once | --watch <seconds>] [--json]');
  expect(hint).toHaveTextContent(EMAIL_DROP_USAGE);
  expect(hint).toHaveTextContent('<inboxDir>');
  expect(hint).toHaveTextContent('<inboxDir>/../outbox');
  expect(hint).toHaveTextContent('reply .eml');
  // Other silent channels: telegram gets its own pointer, the rest get none.
  expect(within(row('Telegram')).getByTestId('channel-setup-hint')).toHaveTextContent('usage: phm comms setup-telegram');
  for (const label of ['Desktop app', 'Phantom page', 'Terminal', 'Fleet-say', 'Mobile']) {
    expect(within(row(label)).queryByTestId('channel-setup-hint')).toBeNull();
  }
});

it('copies the runnable email drop command, not the usage: prefix', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const row = await renderWith([]);
  fireEvent.click(within(row('Email')).getByRole('button', { name: 'Copy the email drop command: phm comms email-drop <inboxDir> --from <address> [--from <address> ...] [--outbox <dir>] [--processed <dir>] [--once | --watch <seconds>] [--json]' }));
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('phm comms email-drop <inboxDir> --from <address> [--from <address> ...] [--outbox <dir>] [--processed <dir>] [--once | --watch <seconds>] [--json]'));
});

it('shows no hint once the email channel has delivered', async () => {
  const row = await renderWith([{ at: '2026-10-31T04:59:00Z', source: 'email', text: 'fake email order' }]);
  const email = row('Email');
  expect(within(email).queryByTestId('channel-setup-hint')).toBeNull();
  expect(email).toHaveTextContent('last from you 1m ago');
});

it('keeps the last-seen text unchanged when the last email is older than 24 h', async () => {
  const row = await renderWith([{ at: '2026-10-30T04:00:00Z', source: 'email', text: 'old email order' }]);
  const email = row('Email');
  expect(within(email).queryByTestId('channel-setup-hint')).toBeNull();
  expect(email).toHaveTextContent('last 1d ago');
  expect(email).toHaveTextContent('last from you 1d ago · read by the 00:59 pass');
});
