import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, invalidateObserved } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SessionThread, SessionThreadView } from './SessionThread.js';
import { narrowSessionThread, SESSION_THREAD_API } from './session-thread-model.js';
import { arrive, dayBreaks, newCountLabel, reachEnd, startFollow, unseenKeys } from './thread-follow.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
/** Local-time stamps, so the day headings do not depend on the zone the suite runs in. */
const local = (day: number, hour: number) => new Date(2026, 10, day, hour, 0, 0).toISOString();
const NOW = new Date(2026, 10, 19, 15, 0, 0).getTime();

interface Wire { key: string; kind: string; side: string; label: string; at: string | null; text: string; format: string }
const said = (key: string, text: string, at: string | null = local(19, 9)): Wire => ({ key, kind: 'bus', side: 'session', label: 'RQ-A to leader', at, text, format: 'plain' });
const body = (messages: Wire[]) => ({
  schema: 'fleet.session-thread.v1', generatedAt: local(19, 15), id: 'RQ-A',
  session: { id: 'RQ-A', kind: 'worker', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader', state: 'running', lastMessageAgeSeconds: 60, prUrl: null },
  summary: ['Worker on claude.'], messages,
  sources: { activity: 'available', bus: 'available', owner: 'none', replies: 'none', orders: 'none' }, gaps: [],
});

/** The end of the conversation going on and off screen, as the browser would report it. */
function stubEndOnScreen() {
  const callbacks = new Set<(entries: { isIntersecting: boolean }[]) => void>();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { callbacks.add(this.callback); }
    disconnect() { callbacks.delete(this.callback); }
  });
  return (onScreen: boolean) => act(() => { for (const callback of callbacks) callback([{ isIntersecting: onScreen }]); });
}

const log = () => screen.getByRole('list', { name: 'Conversation with RQ-A' });
const kinds = () => [...log().children].map(item => (item.hasAttribute('data-new-mark') ? 'NEW' : item.hasAttribute('data-day') ? `day:${item.textContent}` : item.textContent?.replace(/^.*?(?=one|two|three|four)/, '')));
const reread = () => act(async () => { invalidateObserved('verse-fleet-session-thread:', true); await Promise.resolve(); });

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); });

describe('following a conversation: the model', () => {
  it('counts nothing as new when the conversation opens', () => {
    const state = startFollow('RQ-A', ['a', 'b']);
    expect(unseenKeys(state)).toEqual([]);
    expect(state.markKey).toBeNull();
  });

  it('reads arrivals at once while the end is on screen, and holds them under a mark when it is not', () => {
    const open = startFollow('RQ-A', ['a', 'b']);
    const watched = arrive(open, ['a', 'b', 'c'], true);
    expect(unseenKeys(watched)).toEqual([]);
    expect(watched).toMatchObject({ markKey: null, followed: 1 });

    const away = arrive(open, ['a', 'b', 'c', 'd'], false);
    expect(unseenKeys(away)).toEqual(['c', 'd']);
    expect(away).toMatchObject({ markKey: 'c', followed: 0 });
    // A further arrival leaves the mark on the first message still unread.
    const more = arrive(away, ['a', 'b', 'c', 'd', 'e'], false);
    expect(more.markKey).toBe('c');
    expect(unseenKeys(more)).toEqual(['c', 'd', 'e']);
  });

  it('clears the count at the end, keeps the mark as a place, then moves it for the next arrival', () => {
    const away = arrive(startFollow('RQ-A', ['a']), ['a', 'b'], false);
    const caughtUp = reachEnd(away);
    expect(unseenKeys(caughtUp)).toEqual([]);
    expect(caughtUp.markKey).toBe('b');
    expect(reachEnd(caughtUp)).toBe(caughtUp);
    expect(arrive(caughtUp, ['a', 'b', 'c'], false).markKey).toBe('c');
    expect(arrive(caughtUp, ['a', 'b', 'c'], true).markKey).toBeNull();
  });

  it('drops a mark whose message has left the read, and a re-read with nothing new changes no count', () => {
    const away = arrive(startFollow('RQ-A', ['a']), ['a', 'b'], false);
    expect(arrive(reachEnd(away), ['a'], false).markKey).toBeNull();
    const again = arrive(away, ['a', 'b'], false);
    expect(unseenKeys(again)).toEqual(['b']);
    expect(again.markKey).toBe('b');
  });

  it('words the count', () => {
    expect(newCountLabel(1)).toBe('1 new message');
    expect(newCountLabel(4)).toBe('4 new messages');
  });

  it('heads each day only when the conversation spans more than one, skipping undated messages', () => {
    const sameDay = [{ key: 'a', at: local(19, 9) }, { key: 'b', at: null }, { key: 'c', at: local(19, 14) }];
    expect(dayBreaks(sameDay, NOW).size).toBe(0);
    const spans = [{ key: 'brief', at: null }, { key: 'a', at: local(12, 9) }, { key: 'b', at: local(18, 23) }, { key: 'c', at: 'not a time' },
      { key: 'd', at: local(19, 1) }, { key: 'e', at: local(19, 9) }];
    expect([...dayBreaks(spans, NOW)]).toEqual([['a', 'Thu, Nov 12'], ['b', 'Yesterday'], ['d', 'Today']]);
  });
});

describe('following a conversation: the view', () => {
  it('draws day headings and the New mark as separators between messages, not as messages', () => {
    const thread = narrowSessionThread(body([said('m1', 'one', local(18, 9)), said('m2', 'two', local(19, 9)), said('m3', 'three', local(19, 10))]))!;
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      render(<SessionThreadView thread={thread} sent={[]} onSent={() => {}} markKey="m3" />);
    } finally { vi.useRealTimers(); }
    expect(kinds()).toEqual(['day:Yesterday', 'one', 'day:Today', 'two', 'NEW', 'three']);
    expect(within(log()).getAllByRole('separator')).toHaveLength(3);
    expect(within(log()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('holds arrivals under a New mark with a count while the reader is further up, and clears the count at the end', async () => {
    const setEndOnScreen = stubEndOnScreen();
    let messages = [said('m1', 'one'), said('m2', 'two')];
    stubSurfaceFetch({ routes: { [SESSION_THREAD_API]: () => json(body(messages)) } });
    render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
    await screen.findByText('two');
    expect(screen.queryByRole('button', { name: /new message/ })).toBeNull();
    expect(kinds()).toEqual(['one', 'two']);

    setEndOnScreen(false);
    messages = [...messages, said('m3', 'three'), said('m4', 'four')];
    await reread();
    const pill = await screen.findByRole('button', { name: '2 new messages, go to the first' });
    expect(pill.textContent).toBe('2 new ↓');
    expect(kinds()).toEqual(['one', 'two', 'NEW', 'three', 'four']);

    const mark = log().querySelector('[data-new-mark]')!;
    const scrolled = vi.fn();
    (mark as HTMLElement).scrollIntoView = scrolled;
    fireEvent.click(pill);
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' });

    // Reaching the end reads them: the count goes, the mark stays where the reader left off.
    setEndOnScreen(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: /new message/ })).toBeNull());
    expect(kinds()).toEqual(['one', 'two', 'NEW', 'three', 'four']);
  });

  it('follows arrivals with no mark while the end is on screen, and End goes to the newest message', async () => {
    const setEndOnScreen = stubEndOnScreen();
    let messages = [said('m1', 'one')];
    stubSurfaceFetch({ routes: { [SESSION_THREAD_API]: () => json(body(messages)) } });
    const view = render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
    await screen.findByText('one');
    const end = view.container.querySelector('section')!.lastElementChild as HTMLElement;
    const scrolled = vi.fn();
    end.scrollIntoView = scrolled;

    setEndOnScreen(true);
    messages = [...messages, said('m2', 'two')];
    await reread();
    await screen.findByText('two');
    expect(kinds()).toEqual(['one', 'two']);
    expect(screen.queryByRole('button', { name: /new message/ })).toBeNull();
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });

    scrolled.mockClear();
    fireEvent.keyDown(screen.getByRole('region', { name: 'Session RQ-A' }), { key: 'End' });
    expect(scrolled).toHaveBeenCalledTimes(1);
    // In the reply box End stays a caret key.
    scrolled.mockClear();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message RQ-A' }), { key: 'End' });
    expect(scrolled).not.toHaveBeenCalled();
  });
});
