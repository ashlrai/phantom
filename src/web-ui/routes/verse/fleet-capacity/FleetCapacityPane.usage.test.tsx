/** Render test for the usage window on each Capacity card: the shared bar, the reset, the pairing with open slots, the door to Pools and every state with no reading. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { POOLS_PATH } from '../../../../core/fleet/pools-view.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetCapacityPane } from './FleetCapacityPane.js';
import { at, NOW, poolLane, poolsView } from './usage.test-support.js';

const lanes = [
  { lane: 'claude', running: 2, target: 2, queued: 0, held: false },
  { lane: 'codex-personal', running: 15, target: 24, queued: 0, held: false },
  { lane: 'devin', running: 1, target: 4, queued: 0, held: false },
  { lane: 'local', running: 1, target: 1, queued: 0, held: false },
];
// Seven samples five minutes apart: half an hour watched, so codex-personal left 9 slots open for 30 min = 4.5 slot-h.
const history = {
  v: 1, generatedAt: at(0), from: at(-1), to: at(0), sourceState: 'healthy', dropped: 0,
  samples: Array.from({ length: 7 }, (_, index) => ({ at: new Date(NOW - (30 - index * 5) * 60_000).toISOString(), workers: 1, leaders: 1, paused: false, lanes })),
};
const view = poolsView(
  poolLane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }),
  poolLane('codex-personal', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 }),
  poolLane('local', { window: 'none', usedPct: null, resetAt: null }),
);
type Reply = { body: unknown; status?: number };
function serve(pools: () => Reply) {
  const fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes(POOLS_PATH)) { const reply = pools(); return Response.json(reply.body, { status: reply.status ?? 200 }); }
    return u.startsWith('/api/verse/runs-history?') ? Response.json(history) : Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const card = (name: string) => screen.getByRole('button', { name: `Open ${name} in Lanes` }).closest('li')!;
const usage = (name: string) => within(card(name)).getByTestId('lane-usage');
const drawn = (bar: HTMLElement) => [...bar.children].map(part => [part.getAttribute('data-part'), (part as HTMLElement).style.width || (part as HTMLElement).style.left]);

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('draws each lane\'s usage window on the shared bar, with its reset and how it ends', async () => {
  serve(() => ({ body: view }));
  render(<FleetCapacityPane visible />);
  await screen.findByRole('meter', { name: 'codex-personal usage window' });
  const personal = usage('codex-personal');
  expect(personal).toHaveAttribute('data-usage', 'window');
  expect(personal).toHaveTextContent('20% used · resets in 1 d (');
  expect(personal).toHaveTextContent('read 6 min ago');
  expect(within(personal).getByText((_, node) => node?.tagName === 'TIME')).toHaveAttribute('datetime', at(24));
  const bar = within(personal).getByRole('meter');
  expect(bar).toHaveAttribute('aria-valuetext', '20% used, 85.7% of the window elapsed, 32% by reset at this burn, 68% left unused');
  expect(bar).toHaveAttribute('aria-valuenow', '20');
  expect(bar).toHaveAttribute('data-ending', 'unused');
  expect(drawn(bar)).toEqual([['used', '20%'], ['more', '12%'], ['unused', '68%'], ['elapsed', '85.7%']]);
  // The pairing: allowance set to lapse while this lane's own slots sat open, each figure with its own span.
  const note = within(personal).getByText('68% set to go unused at the reset, and 4.5 slot-h of its slots sat open in the last 24 h.');
  expect(note).toHaveAttribute('data-tone', 'warning');
  expect(within(card('codex-personal')).getByText('Idle').nextElementSibling).toHaveTextContent('4.5 slot-h');
  const claude = usage('claude');
  expect(claude).toHaveTextContent('60% used · resets in 2 d 12 h');
  expect(within(claude).getByText('On pace to use its whole window by the reset.')).not.toHaveAttribute('data-tone');
  expect(screen.getByTestId('lane-usage-key')).toHaveTextContent('Usage window, from phm pools: used added by the reset at this burn left unused time gone');
});

it('says what it does not know instead of drawing a number', async () => {
  serve(() => ({ body: view }));
  render(<FleetCapacityPane visible />);
  await screen.findByRole('meter', { name: 'codex-personal usage window' });
  // A lane pools.v1 does not list: hatched, and it says which read left it out.
  const devin = usage('devin');
  expect(devin).toHaveAttribute('data-usage', 'unknown');
  expect(devin).toHaveTextContent('usage unknown');
  expect(within(devin).getByText('phm pools does not list devin.')).toBeInTheDocument();
  expect(within(devin).getByRole('meter')).toHaveAttribute('data-unread', 'true');
  expect(within(devin).getByRole('meter')).not.toHaveAttribute('aria-valuenow');
  expect(devin).not.toHaveTextContent('%');
  // A lane with nothing metered gets words and no bar at all.
  const local = usage('local');
  expect(local).toHaveAttribute('data-usage', 'plain');
  expect(local).toHaveTextContent('no usage window');
  expect(within(local).queryByRole('meter')).not.toBeInTheDocument();
});

it('reads "usage unknown" on every card when the pools read fails, and leaves the slots alone', async () => {
  serve(() => ({ body: {}, status: 500 }));
  render(<FleetCapacityPane visible />);
  await screen.findAllByText('phm pools could not be read.');
  for (const name of ['claude', 'codex-personal', 'devin', 'local']) {
    expect(usage(name)).toHaveAttribute('data-usage', 'unknown');
    expect(within(usage(name)).getByRole('meter')).toHaveAttribute('data-unread', 'true');
  }
  expect(within(card('codex-personal')).getByText('62.5%')).toBeInTheDocument();
  expect(screen.queryByTestId('lane-usage-key')).not.toBeInTheDocument();
});

it('keeps the last view when a refresh fails and labels it', async () => {
  let fail = false;
  serve(() => fail ? { body: {}, status: 500 } : { body: view });
  render(<FleetCapacityPane visible />);
  await screen.findByRole('meter', { name: 'codex-personal usage window' });
  fail = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await within(usage('claude')).findByText(/last reading/)).toBeInTheDocument();
  expect(usage('claude')).toHaveTextContent('60% used');
  expect(within(usage('claude')).getByRole('meter')).toHaveAttribute('aria-valuenow', '60');
});

it('opens Pools from the usage title, and the Refresh button reads pools again', async () => {
  const fetch = serve(() => ({ body: view }));
  const openPane = vi.fn();
  render(<FleetCapacityPane visible host={{ openPane } as unknown as PaneProps['host']} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Usage window: open codex-personal in Pools' }));
  expect(openPane).toHaveBeenCalledWith('fleet-pools');
  const reads = () => fetch.mock.calls.filter(([url]) => String(url).includes(POOLS_PATH)).length;
  expect(reads()).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await vi.waitFor(() => expect(reads()).toBe(2));
});

it('says it is reading until the first answer, then has no button without a dock to open', async () => {
  let answer: (reply: Response) => void = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes(POOLS_PATH) ? new Promise<Response>(resolve => { answer = resolve; })
    : String(url).startsWith('/api/verse/runs-history?') ? Response.json(history) : Response.json({}, { status: 404 })));
  render(<FleetCapacityPane visible />);
  await screen.findByRole('button', { name: 'Open claude in Lanes' });
  expect(usage('claude')).toHaveAttribute('data-usage', 'reading');
  expect(within(usage('claude')).getByRole('status')).toHaveTextContent('Reading usage…');
  expect(within(usage('claude')).queryByRole('meter')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /in Pools$/ })).not.toBeInTheDocument();
  answer(Response.json(view));
  expect(await screen.findByRole('meter', { name: 'claude usage window' })).toBeInTheDocument();
});
