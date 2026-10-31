import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const threadPath = '/api/verse/leader/thread';

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

function serve(post?: (url: string, body: Record<string, unknown>) => Response | undefined) {
  return stubSurfaceFetch({ routes: {
    [threadPath]: { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
  }, post });
}

async function setup() {
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  return screen.getByRole('textbox', { name: 'Reply to the Leader' });
}

describe('Leader thread pane reply', () => {
  it('sends plain text, clears the draft, refetches and scrolls to the end', async () => {
    const net = serve();
    const input = await setup();
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 900 });
    log.scrollTop = 0;
    const readsBefore = net.fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith(threadPath) && init?.method === 'GET').length;
    fireEvent.change(input, { target: { value: '  <b>Hello</b>  \n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
    await waitFor(() => expect(net.posted).toContainEqual({ url: threadPath, body: { text: '  <b>Hello</b>' } }));
    await waitFor(() => expect(input).toHaveValue(''));
    await waitFor(() => expect(net.fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith(threadPath) && init?.method === 'GET').length).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(log.scrollTop).toBe(900));
  });

  it('retains the draft and shows the server reason after a refusal', async () => {
    serve(url => url === threadPath ? new Response(JSON.stringify({ error: 'The Leader is unavailable.' }), { status: 500 }) : undefined);
    const input = await setup();
    fireEvent.change(input, { target: { value: 'Keep my words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The Leader is unavailable.');
    expect(input).toHaveValue('Keep my words');
  });

  it.each(['metaKey', 'ctrlKey'] as const)('sends with %s and Enter', async key => {
    const net = serve();
    const input = await setup();
    fireEvent.change(input, { target: { value: 'Keyboard reply' } });
    fireEvent.keyDown(input, { key: 'Enter', [key]: true });
    await waitFor(() => expect(net.posted).toContainEqual({ url: threadPath, body: { text: 'Keyboard reply' } }));
  });

  it('asks for the mutation token before sending, preserving the draft on cancel', async () => {
    clearMutationToken();
    const net = serve();
    const input = await setup();
    fireEvent.change(input, { target: { value: 'Unlock first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(net.posted).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(input).toHaveValue('Unlock first');
  });

  it('sends the preserved draft after unlocking', async () => {
    clearMutationToken();
    const net = serve();
    const input = await setup();
    fireEvent.change(input, { target: { value: 'Unlock and send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
    fireEvent.change(within(dialog).getByLabelText('Mutation token'), { target: { value: 'b'.repeat(64) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(net.posted).toContainEqual({ url: threadPath, body: { text: 'Unlock and send' } }));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('disables the reply controls while the send is pending', async () => {
    serve();
    const fetchStub = globalThis.fetch;
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === threadPath && init?.method === 'POST' ? pending : fetchStub(input, init)));
    const input = await setup();
    fireEvent.change(input, { target: { value: 'In flight' } });
    const button = screen.getByRole('button', { name: 'Send', exact: true });
    fireEvent.click(button);
    expect(input).toBeDisabled();
    expect(button).toBeDisabled();
    finish(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await waitFor(() => expect(input).not.toBeDisabled());
  });
});
