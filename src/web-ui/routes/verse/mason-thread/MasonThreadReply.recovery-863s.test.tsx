import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { renderMobile, stubFetch } from '../mobile/mobile.test-support.js';
import { MasonThreadCard } from './MasonThreadCard.js';
import { MasonThreadPane } from './MasonThreadPane.js';

const read = 'GET /api/verse/comms/mason-thread';
const post = 'POST /api/verse/leader/inbox';
const thread = { schema: 'phantom.mason.thread.v1', as_of: '2026-11-19T12:00:00.000Z', since: '2026-11-18T12:00:00.000Z', gaps: [], items: [] };
beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); evictAll(); });

describe('desktop Mason thread reply', () => {
  it('sends once on Enter, suppresses rapid submits and refreshes the thread', async () => {
    let resolvePost!: (response: Response) => void;
    const net = stubFetch({ [read]: thread });
    const baseFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>((resolve) => { resolvePost = resolve; });
      return baseFetch(input, init);
    }));
    renderMobile(<MasonThreadPane />);
    await screen.findByText('Nothing yet.');
    const box = screen.getByRole('textbox', { name: 'Message the Leader' });
    fireEvent.change(box, { target: { value: 'ship it' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Sending…' }));
    expect(box).toBeDisabled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const [, options] = vi.mocked(globalThis.fetch).mock.calls[1]!;
    expect(JSON.parse(String(options?.body))).toEqual({ text: 'ship it', source: 'Phantom desktop' });
    resolvePost(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(box).toHaveValue(''));
    await waitFor(() => expect(net.calls.filter((call) => call.method === 'GET')).toHaveLength(2));
  });

  it('retains the draft and displays a write failure', async () => {
    const net = stubFetch({ [read]: thread, [post]: () => new Response(JSON.stringify({ error: 'Inbox full' }), { status: 500, headers: { 'content-type': 'application/json' } }) });
    renderMobile(<MasonThreadPane />);
    const box = await screen.findByRole('textbox', { name: 'Message the Leader' });
    fireEvent.change(box, { target: { value: 'keep this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not sent.');
    expect(box).toHaveValue('keep this');
    expect(net.posts()).toHaveLength(1);
  });

  it('does not send when unlock is cancelled', async () => {
    clearMutationToken();
    const net = stubFetch({ [read]: thread, [post]: { ok: true } });
    renderMobile(<MasonThreadPane />);
    const box = await screen.findByRole('textbox', { name: 'Message the Leader' });
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(net.posts()).toHaveLength(0);
    expect(box).toHaveValue('hello');
  });

  it('does not call an accepted write unsent when refresh fails', async () => {
    let reads = 0;
    const net = stubFetch({ [read]: () => ++reads === 1 ? thread : new Response('{}', { status: 500 }), [post]: { ok: true } });
    renderMobile(<MasonThreadPane />);
    await screen.findByText('Nothing yet.');
    const box = screen.getByRole('textbox', { name: 'Message the Leader' });
    fireEvent.change(box, { target: { value: 'accepted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(box).toHaveValue('');
    expect(screen.queryByText(/Not sent/)).toBeNull();
    expect(net.posts()).toHaveLength(1);
  });

  it('leaves the shared card read-only', async () => {
    stubFetch({ [read]: thread });
    renderMobile(<MasonThreadCard />);
    await screen.findByText('Nothing yet.');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
