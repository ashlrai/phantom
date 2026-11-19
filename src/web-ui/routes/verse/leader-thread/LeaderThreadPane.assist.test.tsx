import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch, type RouteAnswer } from '../command/fetch-stub.test-support.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import { assistSessions, noSessions } from './composer-assist.test-support.js';

const inboxPath = '/api/verse/leader/inbox';
const MIN = 60_000;

// The reply box keeps its unsent draft in localStorage, so each test starts without the last one's text.
beforeEach(() => { evictAll(); window.localStorage.clear(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

function serve(sessions: RouteAnswer | null = assistSessions()) {
  const now = Date.now();
  return stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [
      msg({ id: 'm1', from: 'mason', at: new Date(now - 9 * MIN).toISOString(), text: 'Hold the release.' }),
      msg({ id: 'l1', at: new Date(now - 8 * MIN).toISOString(), text: 'Hello from the Leader.' }),
      msg({ id: 'm2', from: 'mason', at: new Date(now - 7 * MIN).toISOString(), text: 'Ship the fix first.' }),
    ] },
    '/api/verse/leader/directives': { directives: [] },
    [LIVE_SESSIONS_API]: sessions,
  } });
}

async function setup() {
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  return screen.getByRole('textbox', { name: 'Reply to the Leader' }) as HTMLTextAreaElement;
}

/** Types into the reply box with the caret at the end, as a keyboard would leave it. */
function type(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
}

const sessionReads = (net: ReturnType<typeof serve>) => net.fetchMock.mock.calls.filter(([url]) => String(url).startsWith(LIVE_SESSIONS_API)).length;

describe('Leader reply box: aiming with @', () => {
  it('does not read the sessions list until @ is typed, then lists the running sessions', async () => {
    const net = serve();
    const input = await setup();
    type(input, 'Plain words');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(sessionReads(net)).toBe(0);

    type(input, 'Look at @');
    const list = await screen.findByRole('listbox', { name: 'Running sessions' });
    const options = within(list).getAllByRole('option');
    expect(options.map(option => option.querySelector('strong')!.textContent)).toEqual(['@RQ-QUIET', '@RQ-A', '@RQ-CODEX']);
    expect(options[0]).toHaveAttribute('data-state', 'quiet');
    expect(options[0]).toHaveTextContent('quiet 14m');
    expect(options[1]).toHaveTextContent('Running the tests');
    expect(options[2]).toHaveTextContent('Last message unknown');
    expect(screen.getByText('1 running without an RQ id cannot be aimed at')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-controls', list.id);
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
  });

  it('moves with the arrows and writes the chosen job on Enter, sending nothing', async () => {
    const net = serve();
    const input = await setup();
    type(input, 'Look at @');
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('Look at @RQ-A ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(net.posted).toHaveLength(0);

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(net.posted).toContainEqual({ url: inboxPath, body: { source: 'Phantom desktop', text: 'Look at @RQ-A' } }));
  });

  it('narrows as you type, completes with Tab or a click, and wraps upward', async () => {
    serve();
    const input = await setup();
    type(input, '@codex');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('@RQ-CODEX ');

    type(input, '@');
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getAllByRole('option')[0]!);
    expect(input).toHaveValue('@RQ-QUIET ');
  });

  it('closes on Escape without clearing the draft, and says when nothing matches', async () => {
    serve();
    const input = await setup();
    type(input, 'Ask @zzz');
    expect(await screen.findByText('No running session matches “@zzz”.')).toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('No running session matches “@zzz”.')).toBeNull();
    expect(input).toHaveValue('Ask @zzz');
  });

  it('says nobody is working when the list is empty', async () => {
    serve(noSessions());
    const input = await setup();
    type(input, '@');
    expect(await screen.findByText('No agents are working right now.')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it.each([['does not answer', null], ['is not a sessions list', { schema: 'something-else' }]])('reads unavailable, never empty, when the list %s', async (_name, answer) => {
    serve(answer);
    const input = await setup();
    type(input, '@');
    expect(await screen.findByText('Sessions unavailable. You can still type a job id after @.')).toHaveAttribute('data-tone', 'unknown');
    expect(screen.queryByText('No agents are working right now.')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('@');
  });
});

describe('Leader reply box: recalling earlier messages', () => {
  it('brings back what Mason said with Up in an empty box, newer with Down, and clears with Escape', async () => {
    const net = serve();
    const input = await setup();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('Ship the fix first.');
    expect(screen.getByText(/Earlier message/)).toHaveTextContent('Earlier message 2 of 2');
    expect(screen.getByText(/Earlier message/)).toHaveAttribute('role', 'status');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('Hold the release.');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveValue('Ship the fix first.');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveValue('');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
    expect(screen.queryByText(/Earlier message/)).toBeNull();
    expect(net.posted).toHaveLength(0);
  });

  it('leaves the arrows alone while a draft is being written', async () => {
    serve();
    const input = await setup();
    type(input, 'My own words');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('My own words');
    expect(screen.queryByText(/Earlier message/)).toBeNull();
  });
});
