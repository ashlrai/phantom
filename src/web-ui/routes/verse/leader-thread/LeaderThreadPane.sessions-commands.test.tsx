import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { SESSION_THREAD_API } from '../fleet-sessions/session-thread-model.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { takeRequestedWallSession } from '../session-wall/wall-selection.js';
import { assistSessions } from './composer-assist.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const threadBody = {
  schema: 'fleet.session-thread.v1', generatedAt: '2026-11-18T12:00:00Z',
  session: { id: 'RQ-A', kind: 'worker', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader', state: 'running',
    lastMessageAgeSeconds: 120, prUrl: null },
  summary: ['Running for 30 minutes on claude.', 'It last said: Running the tests.'],
  messages: [], sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' }, gaps: [],
};

// No mutation token is held: the session commands only read.
beforeEach(() => { evictAll(); clearMutationToken(); takeRequestedWallSession(); });
afterEach(() => { vi.unstubAllGlobals(); });

/** A result line by its whole text: the jobs it names are buttons, so the text spans elements. */
const resultLine = (log: HTMLElement, text: RegExp) => within(log).findByText((_, element) => element?.tagName === 'P' && text.test(element.textContent ?? ''));

async function setup(routes: Record<string, unknown> = {}) {
  const net = stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
    [LIVE_SESSIONS_API]: assistSessions(),
    [SESSION_THREAD_API]: threadBody,
    ...routes,
  } });
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  const input = screen.getByRole('textbox', { name: 'Reply to the Leader' });
  const run = (text: string) => { fireEvent.change(input, { target: { value: text } }); fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' }); };
  return { net, input, run, log: screen.getByRole('log', { name: 'Conversation with the Leader' }) };
}

describe('session commands in the Leader reply box', () => {
  it('/who answers in the conversation, and a session it names opens as a conversation', async () => {
    const { net, input, run, log } = await setup();
    run('/who');
    const quiet = await within(log).findByRole('button', { name: 'Open the conversation with RQ-QUIET' });
    const line = quiet.closest('p')!;
    expect(line).toHaveTextContent(/^4 working now · 1 quiet: RQ-QUIET \(claude, quiet 14m\) · RQ-A \(claude, spoke 2m ago\)/);
    expect(within(line).getAllByRole('button').map(button => button.textContent)).toEqual(['RQ-QUIET', 'RQ-A', 'RQ-CODEX']);
    expect(input).toHaveValue('');
    // Listing opens nothing by itself.
    expect(takeRequestedWallSession()).toBeNull();

    fireEvent.click(within(line).getByRole('button', { name: 'Open the conversation with RQ-A' }));
    expect(takeRequestedWallSession()).toBe('RQ-A');
    expect(net.posted).toEqual([]);
  });

  it('/thread opens the session and says what it is; an unknown name opens nothing', async () => {
    const { net, run, log } = await setup();
    run('/thread RQ-NOPE');
    expect(await resultLine(log, /^No session named RQ-NOPE is in the session list, so nothing was opened\./)).toBeInTheDocument();
    expect(takeRequestedWallSession()).toBeNull();

    run('/thread @RQ-CODEX');
    expect(await resultLine(log, /^Opened the conversation with/)).toHaveTextContent('Opened the conversation with RQ-CODEX (running, codex-local).');
    await waitFor(() => expect(takeRequestedWallSession()).toBe('RQ-CODEX'));
    expect(net.posted).toEqual([]);
  });

  it('/summary prints what the session is doing without leaving the chat', async () => {
    const { net, run, log } = await setup();
    run('/summary RQ-A');
    const line = await resultLine(log, /last spoke 2m ago/);
    expect(line).toHaveTextContent('RQ-A: running, claude, fixture-model, last spoke 2m ago. Running for 30 minutes on claude. It last said: Running the tests.');
    expect(takeRequestedWallSession()).toBeNull();
    expect(net.fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.startsWith(SESSION_THREAD_API))).toEqual([`${SESSION_THREAD_API}?id=RQ-A`]);
    expect(net.posted).toEqual([]);
  });

  it('says the sessions are unknown when the list is not served, and shows the usage for a missing name', async () => {
    const { run, log } = await setup({ [LIVE_SESSIONS_API]: null });
    run('/who');
    expect(await within(log).findByText(/^Working sessions are unknown\./)).toBeInTheDocument();
    run('/summary');
    expect(await within(log).findByText('/summary needs a session: /summary <session>')).toBeInTheDocument();
  });

  it('lists the session commands as hints while typing', async () => {
    const { input } = await setup();
    fireEvent.change(input, { target: { value: '/th' } });
    expect(within(screen.getByRole('list', { name: 'Composer commands' })).getAllByRole('listitem').map(item => item.textContent))
      .toEqual(['/thread <session> Open a session as a conversation (type @ to pick one)']);
  });
});
