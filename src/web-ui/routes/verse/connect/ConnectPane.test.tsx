/** Render tests for the Connect pane: empty, normal and broken phantom.connect.v1 fixtures, desktop and 390 px. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CONNECT_PATH, CONNECT_SCHEMA, CONNECT_TOGGLE_PATH, type ConnectList, type ConnectRow } from '../../../../core/fleet/connect-schema.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { getPane, listPanes, type PaneProps } from '../panes/pane-registry.js';
import { REGISTERED_DOCK_PANE_GROUPS } from '../shell/dock-pane-catalog.js';
import { buildPaletteItems } from '../shell/palette-model.js';
import { ConnectPane } from './ConnectPane.js';
import './connect.pane.js';

const NOW = Date.parse('2026-11-17T18:00:00.000Z');
const REVISION = 'a'.repeat(40);
const row = (patch: Partial<ConnectRow> & Pick<ConnectRow, 'name' | 'kind'>): ConnectRow => ({
  id: `${patch.kind}:${patch.name}`, source: 'Phantom', state: 'on', lastUsed: 'unknown', users: ['Claude lanes'], needsSignIn: false, next: null, toggle: null, ...patch,
});
const list = (rows: ConnectRow[], patch: Partial<ConnectList> = {}): ConnectList => ({
  schema: CONNECT_SCHEMA, version: 1, at: new Date(NOW).toISOString(), kind: null, unread: [], rows,
  counts: { on: 0, off: 0, broken: 0, unknown: 0, ...Object.fromEntries(['on', 'off', 'broken', 'unknown'].map(s => [s, rows.filter(r => r.state === s).length])) } as ConnectList['counts'],
  ...patch,
});

const normal = list([
  row({ name: 'Terminal', kind: 'channel', lastUsed: new Date(NOW - 5 * 60_000).toISOString(), users: ['Owner', 'Leader'] }),
  row({ name: 'maps', kind: 'connector', source: 'Gateway', state: 'off', users: ['Gateway clients'], next: 'Turn it on, then restart gateway clients.', toggle: { path: CONNECT_TOGGLE_PATH, revision: REVISION } }),
  row({ name: 'scanner', kind: 'plugin', state: 'off', lastUsed: null, next: 'Run `phm plugins enable scanner`.' }),
  row({ name: 'commit', kind: 'skill', source: 'Claude Code' }),
  row({ name: 'Browser', kind: 'tool', source: 'Lane tools', users: ['claude', 'codex'] }),
]);
const broken = list([
  row({ name: 'Slack', kind: 'channel', state: 'broken', next: 'start the bridge: `phm channels slack run`' }),
  row({ name: 'mail', kind: 'connector', source: 'Connector profile', state: 'unknown', users: [], needsSignIn: true, next: 'Sign-in is not checked here.' }),
], { unread: ['plugin'] });

let posts: unknown[] = [];
const serve = (body: unknown, status = 200) => {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.includes(CONNECT_TOGGLE_PATH)) { posts.push(JSON.parse(String(init.body))); return Response.json({ revision: REVISION, connectors: [] }); }
    return url.includes(CONNECT_PATH) ? Response.json(body, { status }) : Response.json({}, { status: 404 });
  }));
};
const props = { visible: true } as PaneProps;
const setWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
};
const labels = () => screen.getAllByRole('listitem').map(item => item.getAttribute('aria-label'));

beforeEach(() => { evictAll(); clearMutationToken(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMutationToken(); setWidth(1024); });

describe.each([['desktop', 1280], ['phone', 390]])('Connect pane at %s width (%i px)', (_name, width) => {
  beforeEach(() => setWidth(width));

  it('empty: says nothing is plugged in', async () => {
    serve(list([]));
    render(<ConnectPane {...props} />);
    expect(await screen.findByText('Nothing is plugged in yet.')).toBeInTheDocument();
    expect(screen.getByText('0 on · 0 off · 0 broken · 0 unknown.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('normal: groups by kind with a state per row, one switch where a route exists, next steps elsewhere', async () => {
    serve(normal);
    render(<ConnectPane {...props} />);
    await screen.findAllByRole('listitem');
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Channels 1', 'Connectors 1', 'Plugins 1', 'Skills 1', 'Tools 1']);
    expect(labels()).toEqual(['Terminal: On', 'maps: Off', 'scanner: Off', 'commit: On', 'Browser: On']);
    expect(screen.getAllByRole('listitem').map(item => item.dataset.state)).toEqual(['on', 'off', 'off', 'on', 'on']);
    expect(screen.getByText('3 on · 2 off · 0 broken · 0 unknown.')).toBeInTheDocument();
    expect(screen.getByText('Phantom · Used by Owner, Leader · Last used 5m ago')).toBeInTheDocument();

    expect(screen.getAllByRole('switch')).toHaveLength(1);
    const scanner = within(screen.getByRole('listitem', { name: 'scanner: Off' }));
    expect(scanner.getByTestId('connect-next')).toHaveTextContent('Next: Run phm plugins enable scanner.');
    expect(scanner.getByRole('button', { name: /the scanner next step/ })).toBeInTheDocument();
    expect(scanner.getByText(/Last used never/)).toBeInTheDocument();
    expect(scanner.queryByRole('switch')).toBeNull();
  });

  it('broken: shows broken and unknown as themselves, "needs sign-in" and unread kinds', async () => {
    serve(broken);
    render(<ConnectPane {...props} />);
    await screen.findAllByRole('listitem');
    expect(labels()).toEqual(['Slack: Broken', 'mail: Unknown']);
    const mail = within(screen.getByRole('listitem', { name: 'mail: Unknown' }));
    expect(mail.getByText('needs sign-in')).toBeInTheDocument();
    expect(mail.getByText('Connector profile · Used by no one named · Last used unknown')).toBeInTheDocument();
    expect(screen.getByText('Some plugins could not be read: unknown.')).toBeInTheDocument();
    expect(screen.getByText('0 on · 0 off · 1 broken · 1 unknown.')).toBeInTheDocument();
  });
});

it('search narrows the list across name, kind, state and lane', async () => {
  serve(normal);
  render(<ConnectPane {...props} />);
  await screen.findAllByRole('listitem');
  const search = screen.getByRole('searchbox', { name: 'Search' });
  fireEvent.change(search, { target: { value: 'codex' } });
  expect(labels()).toEqual(['Browser: On']);
  fireEvent.change(search, { target: { value: 'off plugin' } });
  expect(labels()).toEqual(['scanner: Off']);
  fireEvent.change(search, { target: { value: 'zebra' } });
  expect(screen.getByText('Nothing matches that search.')).toBeInTheDocument();
});

it('the switch is locked until actions are unlocked, then calls the existing connector route once', async () => {
  serve(normal);
  render(<ConnectPane {...props} />);
  const locked = await screen.findByRole('switch', { name: 'maps on' });
  expect(locked).toBeDisabled();
  expect(locked).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText('Unlock actions in Connection to use the switches.')).toBeInTheDocument();

  setMutationToken('unlock');
  await waitFor(() => expect(screen.getByRole('switch', { name: 'maps on' })).toBeEnabled());
  fireEvent.click(screen.getByRole('switch', { name: 'maps on' }));
  expect(await screen.findByText('maps is on. Restart gateway clients to apply it.')).toBeInTheDocument();
  expect(posts).toEqual([{ name: 'maps', enabled: true, revision: REVISION, confirm: true }]);
});

it('a drifted payload is loud, not a blank list', async () => {
  serve({ ...normal, schema: 'phantom.connect.v0' });
  render(<ConnectPane {...props} />);
  expect(await screen.findByText('Connect is unavailable.')).toBeInTheDocument();
});

it('lays out without sideways scroll at 390 px: shrinking rows, wrapping text, no wide fixed widths', () => {
  // jsdom has no layout engine: assert the stylesheet the 390 px layout depends on.
  const css = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/connect/connect.module.css'), 'utf8');
  expect(css).toMatch(/\.row \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/);
  expect(css).toMatch(/\.body \{[^}]*min-width: 0/);
  expect(css).toMatch(/\.search \{[^}]*width: 100%/);
  expect(css).toMatch(/\.switch \{[^}]*width: 2\.75rem; height: 2\.75rem/); // 44 px touch target
  for (const m of css.matchAll(/(?:^|[^-])(?:min-)?width:\s*(\d+)px/g)) expect(Number(m[1])).toBeLessThanOrEqual(390);
});

it('registers a session-free Connect pane that ⌘K lists and the dock groups under Fleet', () => {
  expect(getPane('connect')).toMatchObject({ id: 'connect', title: 'Connect', needsSession: false });
  expect(REGISTERED_DOCK_PANE_GROUPS['connect']).toBe('fleet');
  const items = buildPaletteItems({
    panes: listPanes(), needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac',
  });
  expect(items.find(item => item.key === 'pane:connect')).toMatchObject({ title: 'Open pane: Connect', payload: { kind: 'pane', paneId: 'connect' } });
});
