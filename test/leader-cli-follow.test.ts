import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeaderThreadMessage } from '../src/core/vision/leader-thread-types.js';
import type { readLeaderChat } from '../src/core/fleet/leader-chat.js';

const state = vi.hoisted(() => ({ messages: [] as LeaderThreadMessage[], readChat: vi.fn<typeof readLeaderChat>() }));
vi.mock('../src/core/fleet/leader-chat.js', () => ({ readLeaderChat: state.readChat }));
vi.mock('../src/core/vision/leader-thread.js', () => ({
  listThread: () => state.messages,
  listLeaderThread: async () => state.messages,
  LeaderThreadError: class extends Error {},
}));
import { runLeaderCli } from '../src/cli/leader.js';

const message = (id: string): LeaderThreadMessage => ({ id, at: '2026-01-01T00:00:00Z', from: 'mason', channel: 'verse', kind: 'message', text: id });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); state.messages = []; state.readChat.mockReset(); });

describe('leader thread CLI', () => {
  it('streams NDJSON and exits on signal', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    state.messages = [message('a')];
    const run = runLeaderCli(['thread', '--follow', '--json']);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    state.messages.push(message('b'));
    await vi.advanceTimersByTimeAsync(2000);
    process.emit('SIGINT');
    expect(await run).toBe(0);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(state.messages);
  });

  it('prints the one-shot owner chat JSON without reading the follow stream', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    state.messages = [message('a')];
    const chat: Awaited<ReturnType<typeof readLeaderChat>> = {
      v: 1, generatedAt: '2026-01-01T00:01:00.000Z',
      messages: [{ id: 'owner-a', ts: '2026-01-01T00:00:00.000Z', direction: 'to-leader', channel: 'cli', text: 'a', state: 'sent', received: false }],
      skipped: { malformedInbox: 0 }, sources: { inbox: 'ok', replies: 'missing' },
    };
    state.readChat.mockResolvedValue(chat);
    expect(await runLeaderCli(['thread', '--json'])).toBe(0);
    expect(state.readChat).toHaveBeenCalledExactlyOnceWith({ limit: 50 });
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(chat, null, 2));
  });

  it('rejects a missing since value', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runLeaderCli(['thread', '--since'])).toBe(2);
    expect(error.mock.calls[0]?.[0]).toContain('Usage:');
  });
});
