import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LEADER_LAST_LOOKED_KEY } from './leader-catchup-model.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const MIN = 60_000, HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
/** The wall-clock string MASON-OUTBOX.md writes ("YYYY-MM-DD HH:MM" in America/New_York). */
const etWall = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(ms).replace(',', '');

function serve(messages: ReturnType<typeof msg>[], runs: unknown = { inbox: [] }) {
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/leader/thread': { messages },
    '/api/verse/fleet/runs': runs,
  } });
}
const lastLooked = (ms: number) => window.localStorage.setItem(LEADER_LAST_LOOKED_KEY, JSON.stringify(ms));
const stored = () => Number(JSON.parse(window.localStorage.getItem(LEADER_LAST_LOOKED_KEY) ?? 'null'));
const card = () => screen.queryByRole('region', { name: 'Since you last looked' });
const log = () => screen.getByRole('log', { name: 'Conversation with the Leader' });
const nativeScroll = Element.prototype.scrollIntoView;

beforeEach(() => { evictAll(); clearMutationToken(); window.localStorage.removeItem(LEADER_LAST_LOOKED_KEY); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); Element.prototype.scrollIntoView = nativeScroll; window.localStorage.removeItem(LEADER_LAST_LOOKED_KEY); });

describe('Since you last looked, above the Leader conversation', () => {
  it('counts what arrived while Mason was away and shows the newest thing the Leader said', async () => {
    const now = Date.now();
    lastLooked(now - 3 * HOUR);
    serve([
      msg({ id: 'old', at: iso(now - 4 * HOUR), text: 'Old news from before.' }),
      msg({ id: 'new', at: iso(now - 30 * MIN), text: 'The judge queue is clear.' }),
    ], {
      inbox: [],
      outbox: [{ at: etWall(now - 20 * MIN), text: 'Needs you: approve the spend raise.' }],
      mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 7104, title: 'RQ-PHX-EXAMPLE fix', mergedAt: iso(now - 10 * MIN) }] },
    });
    render(<LeaderThreadPane visible />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    const arrived = within(region).getByRole('list', { name: 'What arrived' });
    await waitFor(() => expect([...arrived.querySelectorAll('li')].map(li => li.textContent)).toEqual(['2 Leader messages', '1 needs you', '1 PR merged in the last hour']));
    expect(within(arrived).getByText('1 needs you')).toHaveAttribute('data-tone', 'attention');
    expect(region).toHaveAttribute('data-attention', 'true');
    expect(within(region).getByText('Latest from the Leader').nextElementSibling).toHaveTextContent('Needs you: approve the spend raise.');
    // The moment he left is named, and the card sits above the conversation it summarises.
    expect(region.querySelector('time')).toHaveAttribute('datetime', iso(now - 3 * HOUR));
    expect(region.querySelector('time')).toHaveTextContent(/3h ago$/);
    expect(region.compareDocumentPosition(log()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Looking at the pane moves the mark to now.
    expect(stored()).toBeGreaterThanOrEqual(now);
  });

  it('jumps to the first new line and goes away on Caught up', async () => {
    const now = Date.now();
    lastLooked(now - HOUR);
    serve([
      msg({ id: 'old', at: iso(now - 2 * HOUR), text: 'Old news from before.' }),
      msg({ id: 'first', at: iso(now - 40 * MIN), text: 'First new line.' }),
      msg({ id: 'second', at: iso(now - 10 * MIN), text: 'Second new line.' }),
    ]);
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
    render(<LeaderThreadPane visible />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    expect(await within(region).findByText('2 Leader messages')).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Jump to first new' }));
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toBe(within(log()).getByText('First new line.').closest('section'));
    fireEvent.click(within(region).getByRole('button', { name: 'Caught up' }));
    expect(card()).toBeNull();
    expect(within(log()).getByText('Second new line.')).toBeInTheDocument();
  });

  it('closes on Escape from inside the card', async () => {
    const now = Date.now();
    lastLooked(now - HOUR);
    serve([msg({ id: 'new', at: iso(now - 10 * MIN), text: 'One new line.' })]);
    render(<LeaderThreadPane visible />);
    const region = await screen.findByRole('region', { name: 'Since you last looked' });
    fireEvent.keyDown(within(region).getByRole('button', { name: 'Caught up' }), { key: 'Escape' });
    expect(card()).toBeNull();
  });

  it('records a baseline on the first visit and shows nothing', async () => {
    const now = Date.now();
    serve([msg({ id: 'new', at: iso(now - 10 * MIN), text: 'Already here on the first visit.' })]);
    render(<LeaderThreadPane visible />);
    expect(await within(log()).findByText('Already here on the first visit.')).toBeInTheDocument();
    expect(card()).toBeNull();
    expect(stored()).toBeGreaterThanOrEqual(now);
  });

  it('stays out of the way inside the same sitting and when nothing arrived', async () => {
    const now = Date.now();
    lastLooked(now - 30_000);
    serve([msg({ id: 'new', at: iso(now - 10_000), text: 'Arrived a moment ago.' })]);
    const first = render(<LeaderThreadPane visible />);
    expect(await within(log()).findByText('Arrived a moment ago.')).toBeInTheDocument();
    expect(card()).toBeNull();
    first.unmount();

    evictAll();
    lastLooked(now - HOUR);
    serve([msg({ id: 'old', at: iso(now - 2 * HOUR), text: 'Nothing since this.' })]);
    render(<LeaderThreadPane visible />);
    expect(await within(log()).findByText('Nothing since this.')).toBeInTheDocument();
    expect(card()).toBeNull();
  });

  it('does not open a window while the pane is hidden', async () => {
    const now = Date.now();
    lastLooked(now - HOUR);
    serve([msg({ id: 'new', at: iso(now - 10 * MIN), text: 'Unseen so far.' })]);
    render(<LeaderThreadPane visible={false} />);
    await Promise.resolve();
    expect(card()).toBeNull();
    // The mark is untouched, so the absence is still counted when the pane is shown.
    expect(stored()).toBe(now - HOUR);
  });
});
