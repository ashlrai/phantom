/** Render tests for the Channels pane: cards from phantom.channels.v1, failing first, desktop and 390 px. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { CHANNELS_OVERVIEW_SCHEMA, CHANNELS_PATH, type ChannelOverviewRow, type ChannelsOverview } from '../../../../core/fleet/channels-schema.js';
import { evictAll } from '../../../data/cache.js';
import { getPane, listPanes, type PaneProps } from '../panes/pane-registry.js';
import { REGISTERED_DOCK_PANE_GROUPS } from '../shell/dock-pane-catalog.js';
import { buildPaletteItems } from '../shell/palette-model.js';
import { ChannelsPane } from './ChannelsPane.js';
import './channels.pane.js';

const NOW = Date.parse('2026-11-17T18:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const row = (patch: Partial<ChannelOverviewRow> & Pick<ChannelOverviewRow, 'channel' | 'label'>): ChannelOverviewRow => ({
  state: 'connected', reason: null, lastInboundAt: ago(5), lastOutboundAt: 'unknown', messages24h: 3, verifiedSenders: 1,
  address: null, next: null, ...patch,
});

// The server already sorted failing first; the pane must keep its order.
const fixture: ChannelsOverview = {
  schema: CHANNELS_OVERVIEW_SCHEMA, version: 1, at: new Date(NOW).toISOString(),
  counts: { connected: 2, 'not-set-up': 1, failing: 1, unknown: 1 },
  channels: [
    row({ channel: 'slack', label: 'Slack', state: 'failing', reason: 'slack bridge process not running', address: '*****ABCD',
      lastOutboundAt: ago(120), next: 'start the bridge: `phm channels slack run --seconds 300`' }),
    row({ channel: 'imessage', label: 'iMessage', state: 'unknown', reason: 'imessage bridge process liveness unverifiable',
      lastInboundAt: 'unknown', messages24h: 'unknown', address: '********4567', next: 'run `phm fleet channel-health` for the detail' }),
    row({ channel: 'email', label: 'Email', state: 'not-set-up', lastInboundAt: null, messages24h: 0, verifiedSenders: 0,
      next: 'phm channels add email <inboxDir> --from <address>' }),
    row({ channel: 'telegram', label: 'Telegram', address: '*****6789' }),
    row({ channel: 'cli', label: 'Terminal', verifiedSenders: null }),
  ],
};

const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async (url: string) =>
  url.includes(CHANNELS_PATH) ? Response.json(body, { status }) : Response.json({}, { status: 404 })));
const props = { visible: true } as PaneProps;
const setWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
};

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setWidth(1024); });

describe.each([['desktop', 1280], ['phone', 390]])('Channels pane at %s width (%i px)', (_name, width) => {
  beforeEach(() => setWidth(width));

  it('draws one card per channel, failing first, in plain words', async () => {
    serve(fixture);
    render(<ChannelsPane {...props} />);
    const cards = await screen.findAllByRole('listitem');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Slack: Failing', 'iMessage: Unknown', 'Email: Not set up', 'Telegram: Connected', 'Terminal: Connected',
    ]);
    expect(cards.map((c) => c.dataset.state)).toEqual(['failing', 'unknown', 'not-set-up', 'connected', 'connected']);
    expect(screen.getByText('2 connected · 1 failing · 1 unknown · 1 not set up.')).toBeInTheDocument();

    const slack = within(cards[0]!);
    expect(slack.getByText('slack bridge process not running')).toBeInTheDocument();
    expect(slack.getByText('5m ago')).toBeInTheDocument();
    expect(slack.getByText('2h ago')).toBeInTheDocument();
    expect(slack.getByText('*****ABCD')).toBeInTheDocument();
    expect(slack.getByTestId('channel-next')).toHaveTextContent('Next: start the bridge: phm channels slack run --seconds 300');
    expect(slack.getByRole('button', { name: /the Slack next step/ })).toBeInTheDocument();

    const imessage = within(cards[1]!);
    expect(imessage.getByText('unknown: imessage bridge process liveness unverifiable')).toBeInTheDocument();
    expect(imessage.getAllByText('unknown').length).toBeGreaterThanOrEqual(3); // last in, last out, 24 h

    const email = within(cards[2]!);
    expect(email.getByText('never')).toBeInTheDocument();
    // A next step without a `command` span gets no copy control.
    expect(email.queryByRole('button')).toBeNull();

    expect(within(cards[3]!).queryByTestId('channel-next')).toBeNull();
    expect(within(cards[4]!).getByText('built in')).toBeInTheDocument();
  });
});

it('lays out without sideways scroll at 390 px: fluid grid, no fixed widths', () => {
  // jsdom has no layout engine: assert the stylesheet the 390 px layout depends on.
  const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/channels/channels.module.css'), 'utf8');
  expect(css).toMatch(/grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, [^)]+\), 1fr\)\)/);
  expect(css).toMatch(/\.card \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/);
  for (const m of css.matchAll(/(?:^|[^-])(?:min-)?width:\s*(\d+)px/g)) expect(Number(m[1])).toBeLessThanOrEqual(390);
});

it('a drifted payload is loud, not a blank list', async () => {
  serve({ ...fixture, schema: 'phantom.channels.v0' });
  render(<ChannelsPane {...props} />);
  expect(await screen.findByText('Channels are unavailable.')).toBeInTheDocument();
});

it('registers a session-free Channels pane that ⌘K lists and the dock groups under talking', () => {
  expect(getPane('channels')).toMatchObject({ id: 'channels', title: 'Channels', needsSession: false });
  expect(REGISTERED_DOCK_PANE_GROUPS['channels']).toBe('talk');
  const items = buildPaletteItems({
    panes: listPanes(), needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac',
  });
  expect(items.find((item) => item.key === 'pane:channels')).toMatchObject({ title: 'Open pane: Channels', payload: { kind: 'pane', paneId: 'channels' } });
});
