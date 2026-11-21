import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';
import { NO_REPLY_NOTICE } from './AskNow.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const threadPath = '/api/verse/leader/thread';
const inboxPath = '/api/verse/leader/inbox';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

/** A server whose thread grows when a POST is answered, the way the real one does. */
function serve(answer: (text: string) => Response | Promise<Response>, routes: Record<string, unknown> = {}) {
  const messages: LeaderThreadMessage[] = [msg({ id: 'one', text: 'Hello from the Leader.' })];
  const net = stubSurfaceFetch({
    routes: { [threadPath]: () => json({ messages }), '/api/verse/leader/directives': { directives: [] }, ...routes },
    post: (url, body) => url === threadPath ? answer(String(body.text)) : url === inboxPath ? json({ ok: true }) : undefined,
  });
  /** What the server sends back once the Leader has answered: both messages are in the thread by then. */
  const answered = (text: string, reply: string | null) => {
    const message = msg({ id: `m-${messages.length}`, from: 'mason', text });
    const said = reply === null ? null : msg({ id: `r-${messages.length}`, text: reply });
    messages.push(message, ...(said ? [said] : []));
    return json({ message, reply: said });
  };
  return { net, answered };
}

async function open(text?: string) {
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  const input = screen.getByRole('textbox', { name: 'Reply to the Leader' });
  if (text !== undefined) fireEvent.change(input, { target: { value: text } });
  return input;
}

const askButton = () => screen.getByRole('button', { name: 'Ask now' });
const posts = (net: { posted: { url: string }[] }, url: string) => net.posted.filter(post => post.url === url);

describe('Leader pane: Ask now', () => {
  it('shows the words at once, frees the box while the Leader answers, then gives way to the thread', async () => {
    let release: (response: Response) => void = () => undefined;
    const { net, answered } = serve(() => new Promise<Response>(resolve => { release = resolve; }));
    const input = await open('How is the release going?');
    fireEvent.click(askButton());

    const mine = await screen.findByRole('region', { name: 'You, asking now' });
    expect(mine).toHaveTextContent('How is the release going?');
    expect(within(mine).getByText('Ask now')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Leader, replying' })).getByRole('status')).toHaveTextContent('Waiting for the Leader’s reply…');
    expect(input).toHaveValue('');
    expect(input).not.toBeDisabled();
    expect(net.posted).toContainEqual({ url: threadPath, body: { text: 'How is the release going?' } });

    // One ask at a time; the inbox send stays open for anything typed meanwhile.
    fireEvent.change(input, { target: { value: 'And another thing' } });
    expect(askButton()).toBeDisabled();
    expect(askButton()).toHaveAttribute('title', expect.stringContaining('answering your last question'));
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();

    release(answered('How is the release going?', 'Two PRs left, both green.'));
    expect(await screen.findByText('Two PRs left, both green.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'You, asking now' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Leader, replying' })).toBeNull();
    expect(screen.getAllByText('How is the release going?')).toHaveLength(1);
    expect(input).toHaveValue('And another thing');
    expect(posts(net, inboxPath)).toHaveLength(0);
    await waitFor(() => expect(askButton()).not.toBeDisabled());
  });

  it('asks on Cmd+Shift+Enter and still sends to the inbox on Cmd+Enter', async () => {
    const { net, answered } = serve(text => answered(text, 'Answered.'));
    const input = await open('Ask this');
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, shiftKey: true });
    await waitFor(() => expect(posts(net, threadPath)).toHaveLength(1));
    expect(await screen.findByText('Answered.')).toBeTruthy();
    expect(posts(net, inboxPath)).toHaveLength(0);

    fireEvent.change(input, { target: { value: 'Order this' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(net.posted).toContainEqual({ url: inboxPath, body: { text: 'Order this', source: 'Phantom desktop' } }));
    expect(posts(net, threadPath)).toHaveLength(1);
  });

  it('keeps a refused ask on screen with the reason, and tries again, edits or discards it', async () => {
    let fail = true;
    const { net, answered } = serve(text => fail ? json({ error: 'Thread is down.' }, 500) : answered(text, 'Back now.'));
    const input = await open('Are you there?');
    fireEvent.click(askButton());

    const mine = await screen.findByRole('region', { name: 'You, not sent' });
    expect(within(mine).getByRole('alert')).toHaveTextContent('Not sent: Thread is down.');
    expect(screen.queryByRole('region', { name: 'Leader, replying' })).toBeNull();
    expect(input).toHaveValue('');

    // Edit: the words return to the box, above what was typed since.
    fireEvent.change(input, { target: { value: 'typed since' } });
    fireEvent.click(within(mine).getByRole('button', { name: 'Edit' }));
    expect(input).toHaveValue('Are you there?\n\ntyped since');
    expect(screen.queryByRole('region', { name: 'You, not sent' })).toBeNull();

    // Try again posts the same words once more.
    fireEvent.change(input, { target: { value: 'Are you there?' } });
    fireEvent.click(askButton());
    const again = await screen.findByRole('region', { name: 'You, not sent' });
    fail = false;
    fireEvent.click(within(again).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Back now.')).toBeTruthy();
    expect(posts(net, threadPath)).toHaveLength(3);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'You, not sent' })).toBeNull());

    // Discard drops a refused ask without touching the box.
    fail = true;
    fireEvent.change(input, { target: { value: 'Never mind' } });
    fireEvent.click(askButton());
    const last = await screen.findByRole('region', { name: 'You, not sent' });
    fireEvent.click(within(last).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'You, not sent' })).toBeNull();
    expect(input).toHaveValue('');
  });

  it('says so when the Leader recorded the message and did not answer', async () => {
    const { answered } = serve(text => answered(text, null));
    await open('Noted?');
    fireEvent.click(askButton());
    expect(await screen.findByText(NO_REPLY_NOTICE)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'You, asking now' })).toBeNull());
    expect(screen.getAllByText('Noted?')).toHaveLength(1);
  });

  it('is off, with the reason, for an empty box and on a server without the Leader conversation', async () => {
    serve(() => json({}));
    const input = await open();
    expect(askButton()).toBeDisabled();
    expect(askButton()).toHaveAttribute('title', expect.stringContaining('Write something first'));
    fireEvent.change(input, { target: { value: 'Now there are words' } });
    expect(askButton()).not.toBeDisabled();
    expect(askButton()).toHaveAttribute('title', expect.stringContaining('Cmd+Shift+Enter'));
  });

  it('cannot ask a server that has no Leader conversation, and does not post', async () => {
    const net = stubSurfaceFetch({ routes: { [threadPath]: null, '/api/verse/leader/directives': { directives: [] } } });
    render(<LeaderThreadPane visible />);
    const input = await screen.findByRole('textbox', { name: 'Reply to the Leader' });
    fireEvent.change(input, { target: { value: 'Anyone?' } });
    await waitFor(() => expect(askButton()).toHaveAttribute('title', expect.stringContaining('not available on this server')));
    expect(askButton()).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(posts(net, threadPath)).toHaveLength(0);
    expect(input).toHaveValue('Anyone?');
  });

  it('asks for the token first and keeps the draft', async () => {
    clearMutationToken();
    const { net } = serve(() => json({}));
    const input = await open('Locked question');
    fireEvent.click(askButton());
    expect(await screen.findByText(/Messaging the Leader requires the dispatch token\./)).toBeTruthy();
    expect(input).toHaveValue('Locked question');
    expect(posts(net, threadPath)).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'You, asking now' })).toBeNull();
  });
});
