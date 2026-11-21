/**
 * The earlier entries of a session conversation: the read shows the newest few
 * of each record, says when a deeper read holds more, and "Show earlier" (or E)
 * asks for it at depth=full. Fixtures only; no server is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, invalidateObserved } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SessionThread, SessionThreadView } from './SessionThread.js';
import { narrowSessionThread, SESSION_THREAD_API, sessionThreadQuery } from './session-thread-model.js';
import { earlierLine, earlierState } from './ThreadEarlier.js';
import { forgetEarlier, setWantsEarlier, wantsEarlier } from './thread-depth.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const at = (minute: number) => new Date(Date.UTC(2026, 10, 19, 9, minute)).toISOString();
const said = (index: number) => ({ key: `bus:m${index}`, kind: 'bus', side: 'session', label: 'RQ-A to leader', at: at(index), text: `message ${index}`, format: 'plain' });
const NEWEST = [said(3), said(4)], EVERY = [said(1), said(2), said(3), said(4)];

/** A fleet.session-thread.v1 body as the server sends it at each depth. */
function wire(depth: 'recent' | 'full' | undefined, over: Record<string, unknown> = {}) {
  return {
    schema: 'fleet.session-thread.v1', generatedAt: at(30), id: 'RQ-A',
    session: { id: 'RQ-A', kind: 'worker', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader', state: 'done', lastMessageAgeSeconds: 60, prUrl: null },
    summary: ['Worker on claude.'], messages: depth === 'full' ? EVERY : NEWEST,
    sources: { activity: 'none', bus: 'available', owner: 'none', replies: 'none', orders: 'none' },
    gaps: depth === 'full' ? [] : ['2 earlier bus messages not shown.'],
    ...(depth === undefined ? {} : { depth, deeper: depth === 'recent' }), ...over,
  };
}
/** Answers each read at the depth its URL asks for, and keeps the URLs. */
function serve(answer: (full: boolean) => Response = full => json(wire(full ? 'full' : 'recent'))) {
  const net = stubSurfaceFetch({ routes: { [SESSION_THREAD_API]: (url: string) => answer(url.includes('depth=full')) } });
  vi.stubGlobal('fetch', net.fetchMock);
  const asked = () => net.fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.startsWith(SESSION_THREAD_API));
  return { asked };
}
const open = () => render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
const texts = () => within(screen.getByRole('list', { name: 'Conversation with RQ-A' })).getAllByText(/^message \d$/).map(node => node.textContent);
const reread = () => act(async () => { invalidateObserved('verse-fleet-session-thread:', true); await Promise.resolve(); });

beforeEach(() => { evictAll(); forgetEarlier(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); forgetEarlier(); });

describe('the earlier entries of a conversation: the model', () => {
  it('reads the depth the server names, and believes "deeper" only of a recent read', () => {
    expect(narrowSessionThread(wire('recent'))).toMatchObject({ depth: 'recent', deeper: true });
    expect(narrowSessionThread(wire('full'))).toMatchObject({ depth: 'full', deeper: false });
    expect(narrowSessionThread(wire('full', { deeper: true }))).toMatchObject({ depth: 'full', deeper: false });
    expect(narrowSessionThread(wire('recent', { deeper: 'yes' }))).toMatchObject({ depth: 'recent', deeper: false });
    // A server that names no depth cannot be asked for more.
    expect(narrowSessionThread(wire(undefined))).toMatchObject({ depth: null, deeper: false });
    expect(narrowSessionThread(wire(undefined, { depth: 'everything', deeper: true }))).toMatchObject({ depth: null, deeper: false });
  });

  it('keeps a full read whole: several hundred messages, where the newest-entries read holds far fewer', () => {
    const many = Array.from({ length: 900 }, (_, index) => ({ ...said(index), key: `bus:m${index}` }));
    expect(narrowSessionThread(wire('full', { messages: many }))!.messages).toHaveLength(800);
  });

  it('names each state of the row, and what it says once the earlier entries are shown', () => {
    const state = (depth: 'recent' | 'full' | null, deeper: boolean, asked: boolean) => earlierState({ depth, deeper }, asked);
    expect([state(null, false, false), state(null, false, true)]).toEqual(['none', 'none']);
    expect([state('recent', false, false), state('recent', true, false), state('recent', true, true), state('recent', false, true)]).toEqual(['none', 'offer', 'reading', 'reading']);
    expect([state('full', false, true), state('full', false, false)]).toEqual(['full', 'folding']);
    expect([earlierLine(null), earlierLine(0), earlierLine(1), earlierLine(41)]).toEqual([
      'Showing the earlier entries too.', 'Nothing earlier is on record: this is every entry.', '1 earlier entry shown above.', '41 earlier entries shown above.']);
  });

  it('asks for depth=full only for a conversation Mason asked to see whole, under the same cache entry', async () => {
    const { asked } = serve();
    expect(sessionThreadQuery('RQ-A').key).toBe('verse-fleet-session-thread:RQ-A');
    await sessionThreadQuery('RQ-A').fetch();
    setWantsEarlier('RQ-A', true);
    expect([wantsEarlier('RQ-A'), wantsEarlier('RQ-B')]).toEqual([true, false]);
    await sessionThreadQuery('RQ-A').fetch();
    await sessionThreadQuery('RQ-B').fetch();
    expect(asked()).toEqual([`${SESSION_THREAD_API}?id=RQ-A`, `${SESSION_THREAD_API}?id=RQ-A&depth=full`, `${SESSION_THREAD_API}?id=RQ-B`]);
    expect(sessionThreadQuery('RQ-A').key).toBe('verse-fleet-session-thread:RQ-A');
  });
});

describe('the earlier entries of a conversation: the view', () => {
  it('offers the earlier entries, keeps the conversation on screen while they are read, and counts what joined', async () => {
    let release: (response: Response) => void = () => {};
    const { asked } = serve(full => (full ? new Promise<Response>(resolve => { release = resolve; }) as unknown as Response : json(wire('recent'))));
    open();
    const button = await screen.findByRole('button', { name: /Show earlier/ });
    expect(texts()).toEqual(['message 3', 'message 4']);
    expect(screen.getByRole('list', { name: 'Not shown' }).textContent).toBe('2 earlier bus messages not shown.');
    expect(button.closest('[data-earlier]')?.getAttribute('data-earlier')).toBe('offer');

    fireEvent.click(button);
    expect(await screen.findByText('Reading the earlier entries…')).toBeTruthy();
    // The read made by the press asks for the full depth; what was on screen stays there meanwhile.
    expect(asked().at(-1)).toBe(`${SESSION_THREAD_API}?id=RQ-A&depth=full`);
    expect(texts()).toEqual(['message 3', 'message 4']);
    expect(screen.queryByRole('button', { name: /Show earlier/ })).toBeNull();

    await act(async () => { release(json(wire('full'))); await Promise.resolve(); });
    await waitFor(() => expect(texts()).toEqual(['message 1', 'message 2', 'message 3', 'message 4']));
    expect(screen.getByText('2 earlier entries shown above.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Not shown' })).toBeNull();
    // Later polls keep asking for the whole conversation.
    await reread();
    expect(asked().at(-1)).toBe(`${SESSION_THREAD_API}?id=RQ-A&depth=full`);
    expect(texts()).toHaveLength(4);
  });

  it('goes back to the newest entries with "Show fewer", and E does both from the conversation but not from a field', async () => {
    const { asked } = serve();
    open();
    await screen.findByRole('button', { name: /Show earlier/ });
    const section = screen.getByRole('region', { name: 'Session RQ-A' });
    // A modified E is the browser's, not this row's.
    fireEvent.keyDown(section, { key: 'e', metaKey: true });
    expect(wantsEarlier('RQ-A')).toBe(false);
    fireEvent.keyDown(section, { key: 'e' });
    await waitFor(() => expect(texts()).toHaveLength(4));
    expect(screen.getByText('2 earlier entries shown above.')).toBeTruthy();
    const first = vi.fn();
    screen.getByRole('list', { name: 'Conversation with RQ-A' }).querySelector('li')!.scrollIntoView = first;
    fireEvent.click(screen.getByRole('button', { name: 'Go to the first' }));
    expect(first).toHaveBeenCalledWith({ block: 'start' });

    fireEvent.click(screen.getByRole('button', { name: /Show fewer/ }));
    await waitFor(() => expect(texts()).toEqual(['message 3', 'message 4']));
    expect(asked().at(-1)).toBe(`${SESSION_THREAD_API}?id=RQ-A`);
    expect(wantsEarlier('RQ-A')).toBe(false);
    expect(await screen.findByRole('button', { name: /Show earlier/ })).toBeTruthy();
  });

  it('shows the plain list and no button when nothing earlier exists, or the server names no depth', async () => {
    const view = (body: unknown) => render(<SessionThreadView thread={narrowSessionThread(body)!} sent={[]} onSent={() => {}} />);
    const none = view(wire('recent', { deeper: false, gaps: ['Older activity is outside the recorded window.'] }));
    expect(screen.getByRole('list', { name: 'Not shown' }).textContent).toBe('Older activity is outside the recorded window.');
    expect(screen.queryByRole('button', { name: /Show earlier/ })).toBeNull();
    expect(none.container.querySelector('[data-earlier]')?.getAttribute('data-earlier')).toBe('none');
    none.unmount();
    view(wire(undefined));
    expect(screen.getByRole('list', { name: 'Not shown' }).textContent).toBe('2 earlier bus messages not shown.');
    expect(screen.queryByRole('button', { name: /Show earlier|Show fewer/ })).toBeNull();
  });

  it('says so when the full read holds nothing more, and keeps what the full read itself leaves out', () => {
    setWantsEarlier('RQ-A', true);
    render(<SessionThreadView thread={narrowSessionThread(wire('full', { gaps: ['5 earlier bus messages not shown.'] }))!} sent={[]} onSent={() => {}} />);
    // This window did not see the earlier entries arrive, so it does not count them.
    expect(screen.getByText('Showing the earlier entries too.')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Not shown' }).textContent).toBe('5 earlier bus messages not shown.');
    expect(screen.getByRole('button', { name: /Show fewer/ })).toBeTruthy();
  });

  it('leaves E alone in the reply box, and keeps the offer when the deeper read fails', async () => {
    const { asked } = serve(full => (full ? json({ error: 'Session thread unavailable.' }, 503) : json(wire('recent'))));
    render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
    await screen.findByRole('button', { name: /Show earlier/ });
    const section = screen.getByRole('region', { name: 'Session RQ-A' });
    const field = document.createElement('textarea');
    section.appendChild(field);
    fireEvent.keyDown(field, { key: 'e' });
    expect(wantsEarlier('RQ-A')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Show earlier/ }));
    await waitFor(() => expect(asked().at(-1)).toContain('depth=full'));
    // The newest entries stay; the row keeps saying it is reading, and the conversation says the refresh failed.
    expect(await screen.findByText(/Refresh failed/)).toBeTruthy();
    expect(texts()).toEqual(['message 3', 'message 4']);
    expect(screen.getByText('Reading the earlier entries…')).toBeTruthy();
  });
});
