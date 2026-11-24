import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { forgetEarlier, wantsEarlier } from '../fleet-sessions/thread-depth.js';
import { forgetFoundPlace, takeFoundPlace } from '../fleet-sessions/thread-found.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { SESSION_FIND_API } from '../session-wall/wall-find.js';
import { takeRequestedWallSession } from '../session-wall/wall-selection.js';
import { assistSessions } from './composer-assist.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const AT = '2026-11-20T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const hit = (key: string, side: string, label: string, text: string, at: string | null = null) => ({ key, kind: key.split(':')[0], side, label, at, text, truncated: false });
const found = (words: string[], results: unknown[], over: Record<string, unknown> = {}) => ({ schema: 'fleet.session-find.v1', generatedAt: AT, words,
  filter: { lane: null, repo: null, live: false }, counts: { sessions: 3, searched: 3, found: results.length }, results,
  sources: { sessions: 'available', bus: 'available', owner: 'available', orders: 'available' }, gaps: [], ...over });
const SUITE = found(['suite'], [
  { session: session('RQ-A'), summary: ['RQ-A is a worker on claude.'], hitCount: 7, messageCount: 9,
    hits: [hit('owner:1', 'other', 'Mason', '@RQ-A run the web Suite before you push', AT), hit('latest', 'session', 'RQ-A', 'Running the web suite now, as RQ-Z did.')] },
  { session: session('RQ-Z', { lane: 'codex', state: 'failed' }), summary: ['RQ-Z failed in the suite step.'], hitCount: 0, messageCount: 4, hits: [] },
]);

// No mutation token is held: /find only reads.
beforeEach(() => { evictAll(); clearMutationToken(); takeRequestedWallSession(); });
afterEach(() => { vi.unstubAllGlobals(); forgetEarlier(); forgetFoundPlace(); });

async function setup(search: unknown) {
  const net = stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
    [LIVE_SESSIONS_API]: assistSessions(),
    [SESSION_FIND_API]: search,
  } });
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  const input = screen.getByRole('textbox', { name: 'Reply to the Leader' });
  const run = (text: string) => { fireEvent.change(input, { target: { value: text } }); fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' }); };
  const searches = () => net.fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.startsWith(SESSION_FIND_API));
  return { net, input, run, searches, log: screen.getByRole('log', { name: 'Conversation with the Leader' }) };
}

describe('/find in the Leader reply box', () => {
  it('answers in the conversation with a row a session, and a session it names opens as a conversation', async () => {
    const { net, input, run, searches, log } = await setup(SUITE);
    run('/find Suite');
    const head = await within(log).findByText(/^2 of 3 searched sessions hold “suite” somewhere in the whole conversation:/);
    const answer = head.closest<HTMLElement>('[data-composer-result]')!;
    expect(answer).toHaveAttribute('data-rows', '2');
    expect(searches()).toEqual([`${SESSION_FIND_API}?q=suite`]);
    expect(input).toHaveValue('');

    const [first, second] = within(answer).getAllByRole('listitem');
    // The newest line that holds the word is the one quoted, as what was said.
    expect(first).toHaveTextContent('RQ-A (running · 7 of 9 messages) said: Running the web suite now, as RQ-Z did.');
    expect(first!.querySelector('q')).toHaveTextContent('Running the web suite now, as RQ-Z did.');
    expect(first).toHaveAttribute('data-quoted');
    expect(second).toHaveTextContent('RQ-Z (failed · in its facts or summary) RQ-Z failed in the suite step.');
    expect(second).not.toHaveAttribute('data-quoted');
    expect(second!.querySelector('q')).toBeNull();

    // Finding opens nothing by itself; a named job does, a job named inside a quoted line included.
    expect(takeRequestedWallSession()).toBeNull();
    expect(within(first!).getAllByRole('button').map(button => button.textContent)).toEqual(['RQ-A', 'RQ-Z', 'Open at this line']);
    // A row with no quoted line has no line to open at.
    expect(within(second!).queryByRole('button', { name: /at this line/ })).toBeNull();
    fireEvent.click(within(second!).getAllByRole('button', { name: 'Open the conversation with RQ-Z' })[0]!);
    expect(takeRequestedWallSession()).toBe('RQ-Z');
    expect(takeFoundPlace('RQ-Z')).toBeNull();

    // "Open at this line" opens the job's conversation and names the line quoted, to be read from the whole conversation.
    fireEvent.click(within(first!).getByRole('button', { name: 'Open RQ-A at this line' }));
    expect([takeRequestedWallSession(), wantsEarlier('RQ-A')]).toEqual(['RQ-A', true]);
    expect(takeFoundPlace('RQ-A')).toEqual({ id: 'RQ-A', words: ['suite'], key: 'latest' });
    expect(net.posted).toEqual([]);
  });

  it('says in one line when no conversation holds the words', async () => {
    const { run, log } = await setup(found(['zebra'], []));
    run('/find zebra');
    const line = await within(log).findByText('No whole conversation holds “zebra”: 3 searched.', { exact: false });
    expect(line.tagName).toBe('P');
    expect(line).toHaveAttribute('data-composer-result');
  });

  it('says unknown, never "none", when the search is not served or answers something else', async () => {
    const missing = await setup(null);
    missing.run('/find suite');
    expect(await within(missing.log).findByText(/^Whether any conversation holds “suite” is unknown: this Phantom server cannot search whole conversations yet\./)).toBeInTheDocument();
    missing.run('/find');
    expect(await within(missing.log).findByText('/find needs a word or two: /find <words>', { exact: false })).toBeInTheDocument();
    missing.run('/find a');
    expect(await within(missing.log).findByText('/find looks for words of two letters or more: /find <words>', { exact: false })).toBeInTheDocument();
    // Neither malformed command asked the server anything.
    expect(missing.searches()).toEqual([`${SESSION_FIND_API}?q=suite`]);
  });

  it('is listed as a hint while typing', async () => {
    const { input } = await setup(SUITE);
    fireEvent.change(input, { target: { value: '/fi' } });
    expect(within(screen.getByRole('list', { name: 'Composer commands' })).getAllByRole('listitem').map(item => item.textContent))
      .toEqual(['/find <words> Find words in every session’s whole conversation']);
  });
});
