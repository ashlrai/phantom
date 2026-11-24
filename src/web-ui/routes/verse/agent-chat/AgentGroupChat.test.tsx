import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentGroupChat } from './AgentGroupChat.js';
import { narrowChatPage } from './chat-reader.js';
const page = (channel = 'engineering', thread = '', after = 0) => ({ status: 'ok', schema: 'agent-chat.v1', channel, asOf: 1000,
  participants: [{ agentId: 'a', handle: 'agent', displayName: 'Agent A', engine: null, avatarColor: '#2563eb', state: 'unknown' }],
  threads: [{ id: 'outcome:one', messageCount: 1, lastCursor: 1 }],
  messages: thread ? [{ id: `m${after + 1}`, cursor: after + 1, receivedAt: 1000, thread, agentId: 'a', kind: 'message', text: '<script>private markup</script>' }] : [],
  nextCursor: after + 1, hasMore: false, retention: 'live-retained-only' });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('Agent group chat boundary', () => {
  it('accepts exact scoped ordered pages', () => expect(narrowChatPage(page('engineering', 'outcome:one'), 'engineering', 'outcome:one', 0)).not.toBeNull());
  it.each([
    ['wrong channel', { channel: 'other' }], ['wrong schema', { schema: 'v2' }], ['fabricated presence', { participants: [{ ...page().participants[0], state: 'online' }] }],
    ['invalid avatar', { participants: [{ ...page().participants[0], avatarColor: 'url(secret)' }] }], ['nonprogress', { nextCursor: 0, hasMore: true }], ['cursor skips unread messages', { nextCursor: 99, hasMore: true }],
    ['unknown sender', { messages: [{ ...page('engineering', 'outcome:one').messages[0], agentId: 'outsider' }] }],
    ['wrong thread', { messages: [{ ...page('engineering', 'outcome:one').messages[0], thread: 'run:two' }] }],
    ['duplicate cursor', { messages: [...page('engineering', 'outcome:one').messages, ...page('engineering', 'outcome:one').messages] }],
  ])('rejects %s', (_, patch) => expect(narrowChatPage({ ...page('engineering', 'outcome:one'), ...patch }, 'engineering', 'outcome:one', 0)).toBeNull());
  it('reads only selected thread, never creates a composer and escapes content', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      calls.push(input); const url = new URL(input, 'http://localhost');
      return new Response(JSON.stringify(page(url.searchParams.get('channel')!, url.searchParams.get('thread') ?? '')));
    }));
    render(<AgentGroupChat channel="engineering" />);
    await screen.findByText('Agent A · Engine unknown · Presence unknown');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'outcome:one' } });
    await screen.findByText('<script>private markup</script>');
    expect(document.querySelector('script')).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('thread=outcome%3Aone');
  });
  it('clears old channel state and ignores a late response on navigation', async () => {
    let finish: ((r: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: string) => input.includes('channel=old') ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(new Response(JSON.stringify(page('new'))))));
    const view = render(<AgentGroupChat channel="old" />);
    view.rerender(<AgentGroupChat channel="new" />);
    await screen.findByText('Agent A · Engine unknown · Presence unknown');
    finish?.(new Response(JSON.stringify({ ...page('old'), participants: [{ ...page().participants[0], displayName: 'Old private name' }] })));
    await waitFor(() => expect(screen.queryByText(/Old private name/)).toBeNull());
    expect(screen.getByText('Channel: new')).toBeTruthy();
  });
  it('renders generic retry instead of backend private errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'SECRET_ERROR' }), { status: 503 })));
    render(<AgentGroupChat channel="engineering" />);
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByText(/SECRET_ERROR/)).toBeNull();
  });
  it('loads subsequent pages only on demand and preserves cursor ordering', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      calls.push(input); const params = new URL(input, 'http://localhost').searchParams;
      const thread = params.get('thread') ?? '', after = Number(params.get('after'));
      const value = page('engineering', thread, after);
      return new Response(JSON.stringify({ ...value, hasMore: !!thread && after === 0 }));
    }));
    render(<AgentGroupChat channel="engineering" />);
    await screen.findByText('Agent A · Engine unknown · Presence unknown');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'outcome:one' } });
    await screen.findByRole('button', { name: 'Load next messages' });
    expect(calls).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Load next messages' }));
    await waitFor(() => expect(screen.getAllByText('<script>private markup</script>')).toHaveLength(2));
    expect(calls[2]).toContain('after=1');
    expect(screen.queryByRole('button', { name: 'Load next messages' })).toBeNull();
  });
  it('supports keyboard focus with native controls and no send action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page()))));
    render(<AgentGroupChat channel="engineering" />);
    await screen.findByText('Agent A · Engine unknown · Presence unknown');
    await userEvent.tab(); expect(document.activeElement).toBe(screen.getByRole('combobox'));
    await userEvent.tab(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
  });

  it.each([false, true])('retries the failed page without losing loaded messages (empty recovery: %s)', async empty => {
    const cursors: number[] = [];
    let failures = 2;
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const params = new URL(input, 'http://localhost').searchParams;
      const thread = params.get('thread') ?? '', after = Number(params.get('after'));
      if (thread) {
        cursors.push(after);
        if (after === 1 && failures-- > 0) return new Response('{}', { status: 503 });
      }
      const value = page('engineering', thread, after);
      return new Response(JSON.stringify({ ...value,
        messages: empty && after === 1 ? [] : value.messages.map(m => ({ ...m, text: `message ${m.cursor}` })),
        hasMore: !!thread && after === 0 }));
    }));
    render(<AgentGroupChat channel="engineering" />);
    await screen.findByText('Agent A · Engine unknown · Presence unknown');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'outcome:one' } });
    await screen.findByText('message 1');
    await userEvent.click(screen.getByRole('button', { name: 'Load next messages' }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await screen.findByRole('button', { name: 'Retry' });
      expect(screen.getAllByText('message 1')).toHaveLength(1);
      await userEvent.click(retry);
    }
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
    expect(cursors).toEqual([0, 1, 1, 1]);
    expect(screen.getAllByText('message 1')).toHaveLength(1);
    expect(screen.queryAllByText('message 2')).toHaveLength(empty ? 0 : 1);
    expect(screen.queryByRole('button', { name: 'Load next messages' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'Load next messages' });
    expect(cursors.at(-1)).toBe(0);
    expect(screen.queryByText('message 2')).toBeNull();
  });

  it('retries a failed initial request from cursor zero', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page())));
    vi.stubGlobal('fetch', fetch);
    render(<AgentGroupChat channel="engineering" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText('Agent A · Engine unknown · Presence unknown');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[1]![0], 'http://localhost').searchParams.get('after')).toBe('0');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

});
