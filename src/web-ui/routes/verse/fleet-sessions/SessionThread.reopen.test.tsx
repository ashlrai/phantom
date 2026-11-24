import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, invalidateObserved } from '../../../data/cache.js';
import { SessionThread } from './SessionThread.js';
import { startFollow, unseenKeys } from './thread-follow.js';
import { forgetThreadRead, messageMark, noteThreadRead, parseThreadRead, reloadThreadRead, THREAD_READ_KEY, unreadSince } from './thread-read-store.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const AT = new Date(2026, 10, 20, 9, 0, 0).toISOString();

interface Wire { key: string; kind: string; side: string; label: string; at: string | null; text: string; format: string }
const said = (key: string, text: string, kind = 'bus'): Wire => ({ key, kind, side: 'session', label: 'RQ-A to leader', at: AT, text, format: 'plain' });
const body = (messages: Wire[]) => ({
  schema: 'fleet.session-thread.v1', generatedAt: AT, id: 'RQ-A',
  session: { id: 'RQ-A', kind: 'worker', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader', state: 'running', lastMessageAgeSeconds: 60, prUrl: null },
  summary: ['Worker on claude.'], messages,
  sources: { activity: 'available', bus: 'available', owner: 'none', replies: 'none', orders: 'none' }, gaps: [],
});
const ONE = said('bus:1', 'one'), TWO = said('bus:2', 'two'), THREE = said('bus:3', 'three'), FOUR = said('bus:4', 'four');

let messages: Wire[] = [];
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
const open = () => render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
/** Closing the conversation and opening the console again: nothing is left in memory, only what storage holds. */
function reload(view: ReturnType<typeof open>) { view.unmount(); evictAll(); reloadThreadRead(); }
const log = () => screen.getByRole('list', { name: 'Conversation with RQ-A' });
const kinds = () => [...log().children].map(item => (item.hasAttribute('data-new-mark') ? 'NEW' : item.textContent?.replace(/^.*?(?=one|two|three|four)/, '')));
const pill = () => screen.queryByRole('button', { name: /new messages?, go to the first/ });
const reread = () => act(async () => { invalidateObserved('verse-fleet-session-thread:', true); await Promise.resolve(); });
const stored = () => parseThreadRead(window.localStorage.getItem(THREAD_READ_KEY));
const nativeScroll = Element.prototype.scrollIntoView;
/** Every scroll the conversation asked for: "mark" for the New rule, "end" for the newest message. */
function watchScrolls() {
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this.hasAttribute('data-new-mark') ? 'mark' : 'end'); };
  return scrolled;
}

beforeEach(() => {
  evictAll(); forgetThreadRead(); setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async () => json(body(messages))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); Element.prototype.scrollIntoView = nativeScroll; });

describe('what was read of a conversation: the record', () => {
  it('calls nothing new in a conversation never read here, then only what arrived since it was', () => {
    expect(unreadSince('RQ-A', [ONE, TWO])).toEqual([]);
    expect(noteThreadRead('RQ-A', [ONE, TWO])).toBe(true);
    expect(unreadSince('RQ-A', [ONE, TWO])).toEqual([]);
    expect(unreadSince('RQ-A', [ONE, TWO, THREE, FOUR])).toEqual(['bus:3', 'bus:4']);
    // Another session's record says nothing about this one.
    expect(unreadSince('RQ-B', [ONE, THREE])).toEqual([]);
  });

  it('knows a message by what it says, not by a key that a later read gives to another message', () => {
    const reply = (index: number, text: string) => said(`reply:${index}`, text, 'reply');
    noteThreadRead('leader', [reply(0, 'Routed to claude.'), reply(1, 'Merged.'), said('latest', 'Planning.', 'latest')]);
    // The oldest reply dropped off, so every position moved; the latest line kept its key and changed its words.
    expect(unreadSince('leader', [reply(0, 'Merged.'), reply(1, 'Two jobs queued.'), said('latest', 'Waiting on a build.', 'latest')])).toEqual(['reply:1', 'latest']);
    expect(messageMark({ kind: 'bus', at: AT, text: 'one' })).toBe(messageMark(ONE));
    expect(messageMark({ kind: 'bus', at: null, text: 'one' })).not.toBe(messageMark(ONE));
  });

  it('keeps fingerprints, never the words, and survives a reload', () => {
    noteThreadRead('RQ-A', [ONE, said('bus:9', 'the release token is in the vault')], 1000);
    const raw = window.localStorage.getItem(THREAD_READ_KEY)!;
    expect(raw).not.toContain('vault');
    expect(stored().get('RQ-A')).toEqual({ at: 1000, marks: [messageMark(ONE), messageMark({ kind: 'bus', at: AT, text: 'the release token is in the vault' })] });
    reloadThreadRead();
    expect(unreadSince('RQ-A', [ONE, TWO])).toEqual(['bus:2']);
  });

  it('drops what it cannot use, and the conversations read longest ago past forty', () => {
    expect(parseThreadRead(null).size).toBe(0);
    expect(parseThreadRead('not json').size).toBe(0);
    expect(parseThreadRead('[1]').size).toBe(0);
    expect([...parseThreadRead(JSON.stringify({ a: 7, b: { at: 'x', marks: [] }, c: { at: 1, marks: 'no' }, d: { at: 2, marks: ['k', 3] } }))]).toEqual([['d', { at: 2, marks: ['k'] }]]);
    for (let n = 0; n < 42; n += 1) noteThreadRead(`RQ-${n}`, [ONE], n);
    expect(stored().size).toBe(40);
    expect(stored().has('RQ-0')).toBe(false);
    expect(stored().has('RQ-1')).toBe(false);
    expect(stored().has('RQ-41')).toBe(true);
  });

  it('lasts as long as the window when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    expect(noteThreadRead('RQ-A', [ONE])).toBe(false);
    expect(unreadSince('RQ-A', [ONE, TWO])).toEqual(['bus:2']);
  });

  it('starts the follow with the mark above the first unread message', () => {
    const state = startFollow('RQ-A', ['a', 'b', 'c', 'd'], ['c', 'd']);
    expect(state.markKey).toBe('c');
    expect(unseenKeys(state)).toEqual(['c', 'd']);
    // A key that is not in the read marks nothing.
    expect(startFollow('RQ-A', ['a', 'b'], ['gone'])).toMatchObject({ markKey: null });
    expect(unseenKeys(startFollow('RQ-A', ['a', 'b'], ['gone']))).toEqual([]);
  });
});

describe('opening a conversation again', () => {
  it('opens at the first message that arrived since it was last read, under the New rule', async () => {
    messages = [ONE, TWO];
    const scrolled = watchScrolls();
    const first = open();
    await waitFor(() => expect(kinds()).toEqual(['one', 'two']));
    // A first opening marks nothing and reads from the newest message.
    expect(pill()).toBeNull();
    expect(scrolled).toEqual(['end']);
    await waitFor(() => expect(stored().get('RQ-A')?.marks).toHaveLength(2));

    reload(first);
    scrolled.length = 0;
    messages = [ONE, TWO, THREE, FOUR];
    open();
    await waitFor(() => expect(kinds()).toEqual(['one', 'two', 'NEW', 'three', 'four']));
    expect(pill()?.textContent).toBe('2 new ↓');
    // The view goes to the rule, not past it to the newest message.
    expect(scrolled).toEqual(['mark']);
    // Not read to the end yet, so the place the next opening counts from has not moved.
    expect(stored().get('RQ-A')?.marks).toHaveLength(2);
  });

  it('counts the new messages as read once the end has been on screen, and marks nothing the next time', async () => {
    const endOnScreen = stubEndOnScreen();
    messages = [ONE, TWO];
    const first = open();
    await waitFor(() => expect(kinds()).toEqual(['one', 'two']));
    await waitFor(() => expect(stored().has('RQ-A')).toBe(true));

    reload(first);
    messages = [ONE, TWO, THREE];
    const second = open();
    await waitFor(() => expect(kinds()).toEqual(['one', 'two', 'NEW', 'three']));
    expect(pill()?.textContent).toBe('1 new ↓');
    await endOnScreen(true);
    // The count goes; the rule stays where it was, as a place.
    expect(pill()).toBeNull();
    expect(kinds()).toEqual(['one', 'two', 'NEW', 'three']);
    await waitFor(() => expect(stored().get('RQ-A')?.marks).toHaveLength(3));

    reload(second);
    open();
    await waitFor(() => expect(kinds()).toEqual(['one', 'two', 'three']));
    expect(pill()).toBeNull();
  });

  it('still calls new, next time, a message that arrived while the reader was further up and never reached', async () => {
    const endOnScreen = stubEndOnScreen();
    messages = [ONE, TWO];
    const first = open();
    await waitFor(() => expect(kinds()).toEqual(['one', 'two']));
    await waitFor(() => expect(stored().has('RQ-A')).toBe(true));
    await endOnScreen(false);
    messages = [ONE, TWO, THREE];
    await reread();
    await waitFor(() => expect(kinds()).toEqual(['one', 'two', 'NEW', 'three']));
    expect(stored().get('RQ-A')?.marks).toHaveLength(2);

    reload(first);
    open();
    await waitFor(() => expect(kinds()).toEqual(['one', 'two', 'NEW', 'three']));
    expect(pill()?.textContent).toBe('1 new ↓');
  });
});
