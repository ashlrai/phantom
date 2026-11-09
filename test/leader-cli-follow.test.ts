import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeaderThreadMessage } from '../src/core/vision/leader-thread-types.js';

const state = vi.hoisted(() => ({ messages: [] as LeaderThreadMessage[] }));
vi.mock('../src/core/vision/leader-thread.js', () => ({
  listThread: () => state.messages,
  listLeaderThread: async () => state.messages,
  LeaderThreadError: class extends Error {},
}));
import { runLeaderCli } from '../src/cli/leader.js';

const message = (id: string): LeaderThreadMessage => ({ id, at: '2026-01-01T00:00:00Z', from: 'mason', channel: 'verse', kind: 'message', text: id });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); state.messages = []; });

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

  it('preserves the one-shot JSON output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    state.messages = [message('a')];
    expect(await runLeaderCli(['thread', '--json'])).toBe(0);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ messages: state.messages }, null, 2));
  });

  it('rejects a missing since value', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runLeaderCli(['thread', '--since'])).toBe(2);
    expect(error.mock.calls[0]?.[0]).toContain('Usage:');
  });
});
