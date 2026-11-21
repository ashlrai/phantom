import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { forgetEarlier } from '../fleet-sessions/thread-depth.js';
import { forgetFoundPlace } from '../fleet-sessions/thread-found.js';
import { SessionWallPane } from './SessionWall.js';
import { NO_SCOPE } from './session-wall-model.js';
import { findFailure, findQuery, foundHeadline, foundMeta, markParts, narrowSessionFind, sessionFindQuery } from './wall-find.js';
import { forgetWallSeen } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';
import { forgetWallView } from './wall-view-store.js';

const AT = '2026-11-20T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
/** The wall holds two sessions; RQ-Z is past what it shows, and only the search knows it. */
const WALL = { schema: 'fleet.session-threads.v1', generatedAt: AT, filter: NO_SCOPE, counts: { sessions: 3 }, gaps: [], threads: [
  { session: session('RQ-A'), summary: ['RQ-A is a worker on claude.'], messageCount: 9, gaps: [],
    messages: [{ key: 'latest', kind: 'latest', side: 'session', label: 'RQ-A', at: null, text: 'Running the web suite now.', format: 'plain' }] },
  { session: session('RQ-B', { lane: 'codex', state: 'quiet' }), summary: ['RQ-B is a worker on codex.'], messageCount: 0, gaps: [], messages: [] },
] };
const hit = (key: string, side: string, label: string, text: string, at: string | null = null) => ({ key, kind: key.split(':')[0], side, label, at, text, truncated: false });
const found = (words: string[], results: unknown[], over: Record<string, unknown> = {}) => ({ schema: 'fleet.session-find.v1', generatedAt: AT, words, filter: NO_SCOPE,
  counts: { sessions: 3, searched: 3, found: results.length }, results, sources: { sessions: 'available', bus: 'available', owner: 'available', orders: 'available' }, gaps: [], ...over });
const SUITE = found(['suite'], [
  { session: session('RQ-A'), summary: ['RQ-A is a worker on claude.'], hitCount: 7, messageCount: 9,
    hits: [hit('owner:1', 'other', 'Mason', '@RQ-A run the web Suite before you push', AT), hit('latest', 'session', 'RQ-A', 'Running the web suite now.')] },
  { session: session('RQ-Z', { lane: 'codex', state: 'failed' }), summary: ['RQ-Z failed in the suite step.'], hitCount: 0, messageCount: 4, hits: [] },
]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function serve(search: (url: URL) => Response) {
  const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    return url.pathname.endsWith('/session-find') ? search(url) : url.pathname.endsWith('/session-threads') ? json(WALL) : json({ error: 'No such route.' }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const searches = (fetch: ReturnType<typeof serve>) => fetch.mock.calls.map(call => String(call[0])).filter(url => url.includes('/session-find'));
const findBox = () => screen.getByRole('searchbox', { name: 'Find in the conversations on screen' });
const block = () => screen.getByRole('region', { name: 'Found in whole conversations' });
const results = () => within(screen.getByRole('list', { name: 'Sessions holding the words' })).getAllByRole('button');
async function mountAndType(words: string) {
  render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
  fireEvent.change(await screen.findByRole('searchbox', { name: 'Find in the conversations on screen' }), { target: { value: words } });
}

beforeEach(() => { evictAll(); forgetWallSeen(); forgetWallView(); setMutationToken('a'.repeat(64)); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); forgetEarlier(); forgetFoundPlace(); });

describe('the search read', () => {
  it('asks only for words the server would search, with the wall\'s own narrowing', () => {
    expect([findQuery(''), findQuery(' a '), findQuery('  Web  SUITE web x ')]).toEqual([null, null, 'web suite']);
    expect(findQuery(`${'ab'.repeat(60)} ${'cd'.repeat(60)}`)).toBe('ab'.repeat(60));
    expect(sessionFindQuery('web suite', NO_SCOPE).key).toBe('verse-fleet-session-find:q=web+suite');
    expect(sessionFindQuery('suite', { lane: 'codex', repo: 'phantom', live: true }).key).toBe('verse-fleet-session-find:q=suite&lane=codex&repo=phantom&live=1');
  });

  it('drops what is malformed, never shows fewer matches than lines, and is no read for another schema', () => {
    expect(narrowSessionFind(WALL)).toBeNull();
    const read = narrowSessionFind(found(['Suite'], [...SUITE.results, { session: {} }, 'x', SUITE.results[0],
      { session: session('RQ-C', { state: 'paused' }), summary: 7, hitCount: 0, hits: [hit('a', 'left', 'L', 'one'), { key: 'b' }] }], { counts: null }))!;
    expect(read.results.map(result => [result.id, result.state, result.hitCount, result.messageCount, result.hits.length]))
      .toEqual([['RQ-A', 'running', 7, 9, 2], ['RQ-Z', 'failed', 0, 4, 0], ['RQ-C', 'unknown', 1, null, 1]]);
    expect([read.words, read.searched, read.results[2]!.hits[0]!.side, read.results[0]!.hits[1]!.at]).toEqual([['suite'], null, 'record', null]);
  });

  it('marks each word where it stands, whatever its case, and says what was found in words', () => {
    expect(markParts('Web suite, websuite', ['web', 'suite', 'websuite'])).toEqual([{ text: 'Web', hit: true }, { text: ' ', hit: false }, { text: 'suite', hit: true },
      { text: ', ', hit: false }, { text: 'websuite', hit: true }]);
    expect(markParts('nothing here', ['suite'])).toEqual([{ text: 'nothing here', hit: false }]);
    const read = narrowSessionFind(SUITE)!;
    expect(foundHeadline(read)).toBe('2 of 3 searched sessions hold “suite” somewhere in the whole conversation');
    expect(foundHeadline({ ...read, results: [] })).toBe('No whole conversation holds “suite”: 3 searched');
    expect(read.results.map(foundMeta)).toEqual(['running · 7 of 9 messages', 'failed · in its facts or summary']);
    expect(findFailure(new Error('offline')).kind).toBe('unavailable');
  });
});

describe('found in whole conversations, under the find box', () => {
  it('asks once the box rests, lists the sessions with the words marked, and opens the one chosen', async () => {
    const fetch = serve(() => json(SUITE));
    await mountAndType('Suite');
    expect(block().textContent).toContain('Searching whole conversations for “suite”…');
    await waitFor(() => expect(results()).toHaveLength(2));
    expect(searches(fetch)).toEqual(['/api/verse/fleet/control/session-find?q=suite']);
    expect(block().textContent).toContain('2 of 3 searched sessions hold “suite” somewhere in the whole conversation');
    const [first, second] = results();
    expect(first!.getAttribute('aria-label')).toBe('Open RQ-A: running · 7 of 9 messages');
    expect(first!.textContent).toContain('5 earlier messages hold them too');
    expect([...first!.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['Suite', 'suite']);
    expect(first!.querySelector('[data-side="other"]')!.textContent).toContain('Mason · ');
    // RQ-Z is not on the wall at all: the words are in its summary, which is shown in place of a line.
    expect(second!.textContent).toContain('RQ-Z failed in the suite step.');
    expect(screen.queryByRole('button', { name: /^RQ-Z,/ })).toBeNull();
    fireEvent.click(second!);
    expect(await screen.findByRole('region', { name: 'Session RQ-Z' })).toBeTruthy();
  });

  it('opens a conversation at the line clicked, and at the newest line shown when the session itself is chosen', async () => {
    const said = (key: string, side: string, label: string, text: string) => ({ key, kind: key.split(':')[0], side, label, at: null, text, format: 'plain' });
    const thread = { schema: 'fleet.session-thread.v1', generatedAt: AT, session: session('RQ-A'), summary: ['RQ-A is a worker on claude.'], gaps: [], depth: 'full', deeper: false,
      messages: [said('owner:1', 'other', 'Mason', '@RQ-A run the web Suite before you push'), said('bus:1', 'session', 'RQ-A', 'On it.'), said('latest', 'session', 'RQ-A', 'Running the web suite now.')],
      sources: { activity: 'none', bus: 'available', owner: 'available', replies: 'none', orders: 'none' } };
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      return path.endsWith('/session-find') ? json(SUITE) : path.endsWith('/session-threads') ? json(WALL) : path.endsWith('/session-thread') ? json(thread) : json({ error: 'No such route.' }, 404);
    });
    vi.stubGlobal('fetch', fetch);
    await mountAndType('suite');
    await waitFor(() => expect(results()).toHaveLength(2));
    const lines = () => [...results()[0]!.querySelectorAll<HTMLElement>('[data-hit]')];
    expect(lines().map(line => line.dataset.hit)).toEqual(['owner:1', 'latest']);
    fireEvent.click(lines()[0]!.querySelector('mark')!);
    const bar = async () => { await waitFor(() => expect(document.querySelector('[data-thread-found="at"]')).not.toBeNull()); return document.querySelector('[data-thread-found]')!.textContent; };
    expect(await bar()).toContain('Found “suite”: entry 1 of 2');
    // The line was found in the whole conversation, so that is what is read.
    expect(fetch.mock.calls.map(call => String(call[0])).filter(url => url.includes('/session-thread?'))).toEqual(['/api/verse/fleet/control/session-thread?id=RQ-A&depth=full']);
    expect(document.querySelector('li[data-found="here"]')!.textContent).toContain('run the web Suite before you push');

    fireEvent.click(screen.getByRole('button', { name: 'Back to every conversation' }));
    fireEvent.click(results()[0]!);
    expect(await bar()).toContain('Found “suite”: entry 2 of 2');
  });

  it('takes Down from the find box to the first result, and past the last result to the cards', async () => {
    serve(() => json(SUITE));
    await mountAndType('suite');
    await waitFor(() => expect(results()).toHaveLength(2));
    fireEvent.keyDown(findBox(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(results()[0]);
    fireEvent.keyDown(results()[0]!, { key: 'j' });
    expect(document.activeElement).toBe(results()[1]);
    fireEvent.keyDown(results()[1]!, { key: 'ArrowUp' });
    fireEvent.keyDown(results()[0]!, { key: 'End' });
    expect(document.activeElement).toBe(results()[1]);
    fireEvent.keyDown(results()[1]!, { key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).dataset.card).toBe('RQ-A');
  });

  it('asks nothing for a single letter, says when nothing is found and lists what was not searched', async () => {
    const fetch = serve(() => json(found(['nowhere'], [], { gaps: ['Bus messages not searched: the agent bus could not be read.'] })));
    await mountAndType('n');
    await new Promise(resolve => setTimeout(resolve, 350));
    expect([searches(fetch), screen.queryByRole('region', { name: 'Found in whole conversations' })]).toEqual([[], null]);
    fireEvent.change(findBox(), { target: { value: 'nowhere' } });
    await waitFor(() => expect(block().textContent).toContain('No whole conversation holds “nowhere”: 3 searched'));
    expect(within(screen.getByRole('list', { name: 'Not searched' })).getByText('Bus messages not searched: the agent bus could not be read.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Sessions holding the words' })).toBeNull();
  });

  it('says why whole conversations could not be searched, and tries again when asked', async () => {
    let up = false;
    const fetch = serve(() => (up ? json(SUITE) : json({ error: 'Sessions unavailable.' }, 503)));
    await mountAndType('suite');
    await waitFor(() => expect(block().textContent).toContain('Whole conversations could not be searched: the session list could not be read just now.'));
    expect(block().dataset.find).toBe('failed');
    up = true;
    fireEvent.click(within(block()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(results()).toHaveLength(2));
    expect(searches(fetch)).toHaveLength(2);
  });

  it('says so on a server without the read, where the cards are still filtered, and on an answer of another shape', async () => {
    serve(() => json({ error: 'not found' }, 404));
    await mountAndType('suite');
    await waitFor(() => expect(block().textContent).toContain('This Phantom server cannot search whole conversations yet.'));
    expect(within(block()).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('button').map(card => card.dataset.card)).toEqual(['RQ-A']);
    cleanup();
    evictAll();
    serve(() => json(WALL));
    await mountAndType('suite');
    await waitFor(() => expect(block().textContent).toContain('The server answered with something that is not a search result.'));
  });
});
