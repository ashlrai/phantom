/**
 * A session conversation opened at a line a find turned up: it is read whole,
 * opens at that line with the words marked, and `,` and `.` step between the
 * entries holding them. Fixtures only; no server is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SessionThread } from './SessionThread.js';
import { SESSION_THREAD_API } from './session-thread-model.js';
import { forgetEarlier, wantsEarlier } from './thread-depth.js';
import { forgetFoundPlace, foundAt, foundLine, foundStep, holdingKeys, openThreadAtFound, takeFoundPlace } from './thread-found.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const at = (minute: number) => new Date(Date.UTC(2026, 10, 19, 9, minute)).toISOString();
const said = (index: number, text: string) => ({ key: `bus:m${index}`, kind: 'bus', side: 'session', label: 'RQ-A to leader', at: at(index), text, format: 'plain' });
const EVERY = [said(1, 'Starting the web Suite.'), said(2, 'Typecheck is clean.'),
  { key: 'step:0', kind: 'step', side: 'record', label: 'tests', at: at(3), text: 'suite passed', format: 'plain' },
  said(4, 'Opening the pull request.'), said(5, 'The suite is green again.')];
const NEWEST = EVERY.slice(3);

function wire(full: boolean) {
  return {
    schema: 'fleet.session-thread.v1', generatedAt: at(30), id: 'RQ-A',
    session: { id: 'RQ-A', kind: 'worker', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader', state: 'running', lastMessageAgeSeconds: 60, prUrl: null },
    summary: ['Worker on claude.'], messages: full ? EVERY : NEWEST,
    sources: { activity: 'available', bus: 'available', owner: 'none', replies: 'none', orders: 'none' },
    gaps: full ? [] : ['3 earlier entries not shown.'], depth: full ? 'full' : 'recent', deeper: !full,
  };
}
function serve() {
  const net = stubSurfaceFetch({ routes: { [SESSION_THREAD_API]: (url: string) => json(wire(url.includes('depth=full'))) } });
  vi.stubGlobal('fetch', net.fetchMock);
  return () => net.fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.startsWith(SESSION_THREAD_API));
}
const open = () => render(<SessionThread id="RQ-A" visible onBack={() => {}} leaderHealth={false} />);
const bar = () => document.querySelector<HTMLElement>('[data-thread-found]');
const here = () => document.querySelector<HTMLElement>('li[data-found="here"]');
const region = () => screen.getByRole('region', { name: 'Session RQ-A' });
/** Every element the view was scrolled to, in order. */
let scrolled: Element[] = [];

beforeEach(() => {
  evictAll(); forgetEarlier(); forgetFoundPlace(); setMutationToken('a'.repeat(64)); scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); clearMutationToken(); forgetEarlier(); forgetFoundPlace();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe('a found line: the model', () => {
  it('finds the entries holding a word in their label or text, whatever its case', () => {
    expect(holdingKeys(EVERY, ['suite'])).toEqual(['bus:m1', 'step:0', 'bus:m5']);
    expect(holdingKeys(EVERY, ['leader', 'zebra'])).toEqual(['bus:m1', 'bus:m2', 'bus:m4', 'bus:m5']);
    expect(holdingKeys(EVERY, ['zebra'])).toEqual([]);
  });

  it('stands at the entry stepped to, else the one chosen, else the newest, and steps no further than the ends', () => {
    const held = ['a', 'b', 'c'];
    expect([foundAt(held, 'a', 'b'), foundAt(held, 'a', null), foundAt(held, 'gone', 'gone'), foundAt(held, null, null), foundAt([], 'a', null)]).toEqual(['b', 'a', 'c', 'c', null]);
    expect([foundStep(held, 'a', -1), foundStep(held, 'a', 1), foundStep(held, 'c', 1), foundStep(held, null, 1)]).toEqual([null, 'b', null, null]);
  });

  it('says where the reader is, and never counts the newest entries as the whole conversation', () => {
    expect(foundLine(['merge', 'queue'], ['a', 'b'], 'b', 60, true)).toBe('Found “merge queue”: entry 2 of 2');
    expect(foundLine(['suite'], ['a'], 'a', 12, false)).toBe('Found “suite”: entry 1 of 1 in the entries shown');
    expect(foundLine(['suite'], [], null, 1, true)).toBe('None of the 1 entry holds “suite”. A find also reads a session\'s id, lane, repo and summary.');
    expect(foundLine(['suite'], [], null, 12, false)).toMatch(/^None of the 12 entries shown holds “suite”\./);
  });

  it('takes a request once, asks for the whole conversation, and refuses what is not a session id or a word', () => {
    openThreadAtFound('RQ-A', [' Suite ', 'suite', 'x'], 'bus:m1');
    expect(wantsEarlier('RQ-A')).toBe(true);
    expect(takeFoundPlace('RQ-B')).toBeNull();
    expect(takeFoundPlace('RQ-A')).toEqual({ id: 'RQ-A', words: ['suite'], key: 'bus:m1' });
    expect(takeFoundPlace('RQ-A')).toBeNull();
    openThreadAtFound('not an id', ['suite']);
    openThreadAtFound('RQ-C', ['x']);
    expect([takeFoundPlace('not an id'), takeFoundPlace('RQ-C'), wantsEarlier('RQ-C')]).toEqual([null, null, false]);
  });
});

describe('a conversation opened at a found line', () => {
  it('is read whole, opens at the line chosen with the words marked, and steps with , and .', async () => {
    const asked = serve();
    openThreadAtFound('RQ-A', ['suite'], 'bus:m1');
    open();
    await waitFor(() => expect(bar()?.dataset.threadFound).toBe('at'));
    expect(asked()).toEqual([`${SESSION_THREAD_API}?id=RQ-A&depth=full`]);
    expect(bar()!.querySelector('[role="status"]')!.textContent).toBe('Found “suite”: entry 1 of 3');
    expect(here()!.textContent).toContain('Starting the web Suite.');
    expect([...document.querySelectorAll('li[data-found] mark')].map(mark => mark.textContent)).toEqual(['Suite', 'suite', 'suite']);
    expect(document.querySelectorAll('li[data-found="held"]')).toHaveLength(2);
    // The reader is taken to the line, not to the end of the conversation first.
    expect(scrolled).toEqual([here()]);
    expect(screen.getByRole('button', { name: /Earlier/ })).toBeDisabled();

    fireEvent.keyDown(region(), { key: '.' });
    expect(bar()!.textContent).toContain('entry 2 of 3');
    expect(here()!.dataset.kind).toBe('step');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    expect(here()!.textContent).toContain('The suite is green again.');
    expect(screen.getByRole('button', { name: /Later/ })).toBeDisabled();
    // In the reply box the keys are punctuation.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message RQ-A' }), { key: ',' });
    expect(bar()!.textContent).toContain('entry 3 of 3');
    fireEvent.keyDown(region(), { key: ',' });
    expect(bar()!.textContent).toContain('entry 2 of 3');
    expect(scrolled.at(-1)).toBe(here());

    const before = scrolled.length;
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect([bar(), document.querySelector('[data-found]'), document.querySelector('li mark'), scrolled.length]).toEqual([null, null, null, before]);
  });

  it('reads a conversation already open at its newest entries again, whole, and then goes to the line', async () => {
    const asked = serve();
    open();
    await screen.findByText('The suite is green again.');
    expect([asked(), bar()]).toEqual([[`${SESSION_THREAD_API}?id=RQ-A`], null]);
    act(() => openThreadAtFound('RQ-A', ['suite'], 'bus:m1'));
    expect(bar()!.textContent).toContain('Reading the whole conversation for “suite”…');
    await waitFor(() => expect(bar()?.dataset.threadFound).toBe('at'));
    expect(asked().at(-1)).toBe(`${SESSION_THREAD_API}?id=RQ-A&depth=full`);
    expect(here()!.textContent).toContain('Starting the web Suite.');
    // The earlier entries arriving do not pull the view to the end.
    await waitFor(() => expect(scrolled.at(-1)).toBe(here()));
  });

  it('says so when no entry holds the words, and when the line chosen is not in the read', async () => {
    serve();
    openThreadAtFound('RQ-A', ['zebra']);
    const first = open();
    await waitFor(() => expect(bar()?.dataset.threadFound).toBe('none'));
    expect(bar()!.textContent).toContain('None of the 5 entries holds “zebra”.');
    expect([screen.queryByRole('button', { name: /Later/ }), here()]).toEqual([null, null]);
    // Nothing to hold the reader at: the conversation opens at its end, as always.
    expect(scrolled.length).toBeGreaterThan(0);
    first.unmount();

    openThreadAtFound('RQ-A', ['suite'], 'bus:gone');
    open();
    await waitFor(() => expect(bar()?.dataset.threadFound).toBe('at'));
    expect(bar()!.textContent).toContain('entry 3 of 3');
    expect(bar()!.querySelector('[data-moved]')!.textContent).toContain('The line you chose is not in this read');
  });

  it('opens at its newest message the next time: a request is taken once', async () => {
    serve();
    openThreadAtFound('RQ-A', ['suite'], 'bus:m1');
    const first = open();
    await waitFor(() => expect(bar()).not.toBeNull());
    first.unmount();
    open();
    await screen.findByText('The suite is green again.');
    expect([bar(), here()]).toEqual([null, null]);
  });
});
