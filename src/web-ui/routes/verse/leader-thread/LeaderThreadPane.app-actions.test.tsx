import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppActionEntry } from '../../../../core/apps-actions.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch, type RouteAnswer } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import { APP_ACTIONS_SHOWN_KEY } from './thread-app-actions.js';

const dock = vi.hoisted(() => ({ openDockPane: vi.fn() }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane: dock.openDockPane }));

const ACTIONS = '/api/verse/apps/actions';
const now = Date.now();
const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
const MIN = 60_000;
const action = (key: string, agoMs: number, over: Partial<AppActionEntry> = {}): AppActionEntry =>
  ({ key, at: iso(agoMs), action: 'open', app: 'Xcode', outcome: 'done', detail: null, ...over });
/** The route's body; `actions` are given oldest first and sent newest first, as the server does. */
const report = (actions: AppActionEntry[], over: Record<string, unknown> = {}) => ({
  schema: 'phm.apps.actions/1', version: 1, generatedAt: new Date(now).toISOString(), source: 'available',
  actions: [...actions].reverse(), total: actions.length, counts: {}, lookups: 0, skipped: 0, truncated: false, ...over,
});

function mount(apps: RouteAnswer | null | undefined) {
  const net = stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [
      msg({ id: 'ask', at: iso(10 * MIN), from: 'mason', text: 'Open the project and run it' }),
      msg({ id: 'answer', at: iso(2 * MIN), text: 'It is open and building' }),
    ] },
    '/api/verse/fleet/runs': { inbox: [] },
    '/api/verse/leader/directives': { directives: [] },
    ...(apps === undefined ? {} : { [ACTIONS]: apps }),
  } });
  const view = render(<LeaderThreadPane visible />);
  return { net, view };
}

const log = () => screen.getByRole('log', { name: 'Conversation with the Leader' });
const runs = () => within(log()).queryAllByRole('region', { name: 'App actions' });
const asked = (net: ReturnType<typeof mount>['net']) => net.fetchMock.mock.calls.filter(([url]) => String(url).startsWith(ACTIONS)).length;

beforeEach(() => { evictAll(); localStorage.clear(); dock.openDockPane.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('places each app action where it happened in the conversation', async () => {
  mount(report([
    action('old', 30 * MIN, { app: 'Mail' }),
    action('a', 6 * MIN),
    action('b', 6 * MIN - 1_000, { action: 'focus' }),
    action('c', MIN, { action: 'quit', app: 'Slack', outcome: 'refused', detail: 'Slack is not on the allowlist' }),
  ]));
  await within(log()).findByText('Opened Xcode');
  const [first, second] = runs();
  expect(runs()).toHaveLength(2);
  // Before the first message shown: not part of this conversation.
  expect(within(log()).queryByText('Opened Mail')).toBeNull();

  expect(within(first!).getByText('2 app actions')).toBeInTheDocument();
  expect(within(first!).getAllByRole('listitem').map(li => li.textContent)).toEqual([
    expect.stringContaining('Opened Xcode'), expect.stringContaining('Brought Xcode to front'),
  ]);
  expect(within(first!).queryByText(/a look/)).toBeNull();

  expect(within(second!).getByText('1 app action')).toBeInTheDocument();
  expect(within(second!).getByText('1 needs a look')).toBeInTheDocument();
  const refused = within(second!).getByRole('listitem');
  expect(refused).toHaveAttribute('data-tone', 'warn');
  expect(refused).toHaveTextContent('Refused to quit Slack');
  expect(refused).toHaveTextContent('Slack is not on the allowlist');

  // Mason's message, the two actions, the Leader's answer, the refused quit: in the order they happened.
  const order = (node: Element) => Array.from(log().querySelectorAll('*')).indexOf(node);
  const ask = within(log()).getByText('Open the project and run it');
  const answer = within(log()).getByText('It is open and building');
  expect(order(ask)).toBeLessThan(order(first!));
  expect(order(first!)).toBeLessThan(order(answer));
  expect(order(answer)).toBeLessThan(order(second!));

  expect(screen.getByText('3 app actions')).toHaveAttribute('title', expect.stringContaining('since the first message shown'));
});

it('opens the Mac host pane from a run', async () => {
  mount(report([action('a', 5 * MIN)]));
  await within(log()).findByText('Opened Xcode');
  fireEvent.click(within(runs()[0]!).getByRole('button', { name: 'Mac host' }));
  expect(dock.openDockPane).toHaveBeenCalledWith('fleet-host');
});

it('folds a long run to its newest three actions until it is opened', async () => {
  mount(report(['Notes', 'Mail', 'Safari', 'Slack', 'Xcode', 'Terminal'].map((app, i) => action(`k${i}`, 6 * MIN - i * 1_000, { app }))));
  await within(log()).findByText('Opened Terminal');
  const [run] = runs();
  expect(within(run!).getByText('6 app actions')).toBeInTheDocument();
  expect(within(run!).getAllByRole('listitem')).toHaveLength(3);
  expect(within(run!).queryByText('Opened Notes')).toBeNull();
  const more = within(run!).getByRole('button', { name: 'Show 3 earlier' });
  expect(more).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(more);
  expect(within(run!).getAllByRole('listitem')).toHaveLength(6);
  expect(within(run!).getByText('Opened Notes')).toBeInTheDocument();
  fireEvent.click(within(run!).getByRole('button', { name: 'Show the newest only' }));
  expect(within(run!).getAllByRole('listitem')).toHaveLength(3);
});

it('finds an action in a folded run and lists the whole run while it matches', async () => {
  mount(report(['Notes', 'Mail', 'Safari', 'Slack', 'Xcode', 'Terminal'].map((app, i) => action(`k${i}`, 6 * MIN - i * 1_000, { app }))));
  await within(log()).findByText('Opened Terminal');
  fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Find in conversation' }), { target: { value: 'notes' } });
  expect(screen.getByText('1 of 1')).toBeInTheDocument();
  const [run] = runs();
  expect(run).toHaveAttribute('data-find-current', 'true');
  expect(within(run!).getByText('Opened Notes')).toBeInTheDocument();
  expect(within(run!).queryByRole('button', { name: /earlier/ })).toBeNull();
});

it('hides the rows, stops reading the log and remembers the choice', async () => {
  const first = mount(report([action('a', 5 * MIN)]));
  await within(log()).findByText('Opened Xcode');
  const toggle = screen.getByRole('button', { name: 'App actions' });
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(runs()).toHaveLength(0);
  expect(screen.queryByText('1 app action')).toBeNull();
  expect(localStorage.getItem(APP_ACTIONS_SHOWN_KEY)).toBe('hidden');
  first.view.unmount();
  vi.unstubAllGlobals();
  evictAll();

  const second = mount(report([action('a', 5 * MIN)]));
  await within(log()).findByText('It is open and building');
  expect(screen.getByRole('button', { name: 'App actions' })).toHaveAttribute('aria-pressed', 'false');
  expect(asked(second.net)).toBe(0);
  expect(runs()).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
  expect(await within(log()).findByText('Opened Xcode')).toBeInTheDocument();
  expect(localStorage.getItem(APP_ACTIONS_SHOWN_KEY)).toBe('shown');
});

it('leaves app actions out of "Needs you only"', async () => {
  mount(report([action('a', 5 * MIN, { outcome: 'needs-you' })]));
  await within(log()).findByText('Asked you before it would open Xcode');
  fireEvent.click(screen.getByRole('button', { name: 'Needs you only' }));
  expect(runs()).toHaveLength(0);
});

it('says the log is unknown when it does not answer, and shows no rows', async () => {
  mount(() => Response.json({ error: 'app actions unavailable' }, { status: 503 }));
  await within(log()).findByText('It is open and building');
  expect(await screen.findByText('App actions unknown')).toHaveAttribute('data-tone', 'unknown');
  expect(runs()).toHaveLength(0);
});

it('says the log is unknown when the feed behind it could not be read', async () => {
  mount(report([], { source: 'unavailable', total: null }));
  await within(log()).findByText('It is open and building');
  expect(await screen.findByText('App actions unknown')).toBeInTheDocument();
});

it.each([
  ['a server without the route', null],
  ['a caller the route does not serve', () => Response.json({ error: 'local request required' }, { status: 403 })],
] as const)('stays silent on %s', async (_name, answer) => {
  const { net } = mount(answer);
  await within(log()).findByText('It is open and building');
  await waitFor(() => expect(asked(net)).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByRole('button', { name: 'App actions' })).toBeInTheDocument());
  expect(screen.queryByText('App actions unknown')).toBeNull();
  expect(screen.queryByText(/app actions?$/)).toBeNull();
  expect(runs()).toHaveLength(0);
});

it('shows nothing extra when the log holds no action', async () => {
  const { net } = mount(report([]));
  await within(log()).findByText('It is open and building');
  await waitFor(() => expect(asked(net)).toBeGreaterThan(0));
  expect(runs()).toHaveLength(0);
  expect(screen.queryByText('App actions unknown')).toBeNull();
});
