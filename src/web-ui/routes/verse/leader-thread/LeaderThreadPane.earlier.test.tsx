import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { leaderThreadQuery } from '../leader/thread-data.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const threadPath = '/api/verse/leader/thread';
const NOW = Date.now();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** Messages numbered `from`..`to`, oldest first, one minute apart, ending five minutes ago at message 200. */
function span(from: number, to: number): LeaderThreadMessage[] {
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const n = from + index;
    return msg({ id: `m${n}`, at: new Date(NOW - (205 - n) * 60_000).toISOString(), text: `Message ${n}.` });
  });
}

interface Served { newest: LeaderThreadMessage[]; earlier: (before: string) => Response; asked: string[] }

function serve(served: Served) {
  return stubSurfaceFetch({ routes: {
    [threadPath]: (url: string) => {
      const before = new URL(url, 'http://localhost').searchParams.get('before');
      if (before === null) return json({ messages: served.newest });
      served.asked.push(before);
      return served.earlier(before);
    },
    '/api/verse/leader/directives': { directives: [] },
  } });
}

async function open(served: Served) {
  serve(served);
  render(<LeaderThreadPane visible />);
  await screen.findByText(`Message ${served.newest.length ? Number(served.newest.at(-1)!.id.slice(1)) : 0}.`);
  return screen.getByRole('log', { name: 'Conversation with the Leader' });
}

const row = () => document.querySelector('[data-earlier-row]');

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('Leader thread pane, earlier messages', () => {
  it('offers nothing when the newest page is the whole thread', async () => {
    await open({ newest: span(190, 200), earlier: () => json({ messages: [] }), asked: [] });
    expect(row()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

  it('loads the page before the oldest message and keeps the reading position', async () => {
    const served: Served = { newest: span(151, 200), earlier: () => json({ messages: span(101, 150) }), asked: [] };
    const log = await open(served);
    expect(row()).toHaveTextContent('Newest 50 thread messages shown');
    expect(screen.queryByText('Message 150.')).toBeNull();

    let height = 1000;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => height });
    log.scrollTop = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    height = 1800;

    expect(await screen.findByText('Message 101.')).toBeInTheDocument();
    expect(served.asked).toEqual(['m151']);
    expect(row()).toHaveTextContent(/^100 thread messages, back to /);
    // The 800 new pixels landed above the line being read, so it stays where it was.
    expect(log.scrollTop).toBe(800);
    const texts = [...log.querySelectorAll('section[data-from]')].map(section => section.textContent ?? '');
    expect(texts.findIndex(text => text.includes('Message 150.'))).toBeLessThan(texts.findIndex(text => text.includes('Message 151.')));

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => expect(served.asked).toEqual(['m151', 'm101']));
  });

  it('marks the start of the conversation when an earlier page comes back short', async () => {
    const served: Served = { newest: span(151, 200), earlier: () => json({ messages: span(131, 150) }), asked: [] };
    await open(served);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('Message 131.');
    expect(row()).toHaveTextContent('Start of the conversation held here · 70 thread messages');
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

  it('says so when nothing earlier is held', async () => {
    await open({ newest: span(151, 200), earlier: () => json({ messages: [] }), asked: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => expect(row()).toHaveTextContent('No earlier messages are held here.'));
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show newest only' })).toBeNull();
  });

  it('shows the reason a page did not load and loads it on a second try', async () => {
    let fail = true;
    const served: Served = { newest: span(151, 200), asked: [],
      earlier: () => fail ? json({ error: 'The thread file is locked.' }, 503) : json({ messages: span(101, 150) }) };
    await open(served);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => expect(row()).toHaveTextContent('Earlier messages did not load. The thread file is locked.'));
    expect(row()).toHaveAttribute('data-state', 'error');
    expect(screen.getByText('Message 151.')).toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Message 101.')).toBeInTheDocument();
    expect(served.asked).toEqual(['m151', 'm151']);
  });

  it('keeps the messages that slide off the newest page once earlier ones are on screen', async () => {
    const served: Served = { newest: span(151, 200), earlier: () => json({ messages: span(101, 150) }), asked: [] };
    await open(served);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('Message 101.');

    // Three new messages arrive; the server's newest page no longer holds 151 to 153.
    served.newest = span(154, 203);
    await act(async () => { await refetchQuery(leaderThreadQuery.key, () => leaderThreadQuery.fetch(), true); });
    expect(await screen.findByText('Message 203.')).toBeInTheDocument();
    for (const n of [150, 151, 152, 153, 154]) expect(screen.getByText(`Message ${n}.`)).toBeInTheDocument();
    expect(row()).toHaveTextContent(/^103 thread messages, back to /);
  });

  it('loads the next page from the keyboard at the top of the focused conversation', async () => {
    const served: Served = { newest: span(151, 200), earlier: () => json({ messages: span(101, 150) }), asked: [] };
    const log = await open(served);
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });

    log.scrollTop = 400;
    fireEvent.keyDown(log, { key: 'Home' });
    expect(served.asked).toEqual([]);

    log.scrollTop = 0;
    fireEvent.keyDown(log, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Reply to the Leader' }), { key: 'ArrowUp' });
    expect(served.asked).toEqual([]);

    fireEvent.keyDown(log, { key: 'Home' });
    expect(await screen.findByText('Message 101.')).toBeInTheDocument();
    expect(served.asked).toEqual(['m151']);
  });

  it('returns to the newest page and the end of the conversation on Show newest only', async () => {
    const served: Served = { newest: span(151, 200), earlier: () => json({ messages: span(101, 150) }), asked: [] };
    const log = await open(served);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('Message 101.');

    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 900 });
    log.scrollTop = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Show newest only' }));
    await waitFor(() => expect(screen.queryByText('Message 150.')).toBeNull());
    expect(screen.getByText('Message 151.')).toBeInTheDocument();
    expect(row()).toHaveTextContent('Newest 50 thread messages shown');
    expect(log.scrollTop).toBe(900);
  });

  it('finds text in the earlier pages once they are loaded', async () => {
    const served: Served = { newest: span(151, 200), earlier: () => json({ messages: span(101, 150) }), asked: [] };
    await open(served);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('Message 101.');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in conversation' }), { target: { value: 'Message 120.' } });
    expect(await screen.findByText('1 of 1')).toBeInTheDocument();
  });
});
