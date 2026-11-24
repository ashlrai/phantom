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
import * as seat from '../src/core/fleet/leader-seat.js';

const message = (id: string): LeaderThreadMessage => ({ id, at: '2026-01-01T00:00:00Z', from: 'mason', channel: 'verse', kind: 'message', text: id });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); state.messages = []; state.readChat.mockReset(); });

describe('leader thread CLI', () => {
  it('prints the same versioned seat report for inspection and pick; rejects writes', async () => {
    const report = seat.buildLeaderSeat(null, null, null, 0);
    const read = vi.spyOn(seat, 'readLeaderSeat').mockResolvedValue(report);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // No seat qualifies in an empty report: the report still prints, and the exit code is 3.
    for (const args of [['seat', '--json'], ['seat', 'pick', '--json']]) {
      expect(await runLeaderCli(args)).toBe(3);
      expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual(report);
    }
    expect(await runLeaderCli(['seat', 'pick'])).toBe(3);
    expect(log.mock.calls.at(-1)![0]).toBe('No seat: lane health is unknown.');
    expect(await runLeaderCli(['seat', 'pick', '--apply'])).toBe(2);
    expect(await runLeaderCli(['seat', 'bogus'])).toBe(2);
    expect(read).toHaveBeenCalledTimes(3);
  });
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

  it('preserves the legacy owner chat JSON without reading the follow stream', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    state.messages = [message('a')];
    const chat: Awaited<ReturnType<typeof readLeaderChat>> = {
      v: 1, generatedAt: '2026-01-01T00:01:00.000Z',
      messages: [{ id: 'owner-a', ts: '2026-01-01T00:00:00.000Z', direction: 'to-leader', channel: 'cli', text: 'a', state: 'sent', received: false }],
      skipped: { malformedInbox: 0 }, sources: { inbox: 'ok', replies: 'missing' },
    };
    state.readChat.mockResolvedValue(chat);
    expect(await runLeaderCli(['thread', '--legacy', '--json'])).toBe(0);
    expect(state.readChat).toHaveBeenCalledExactlyOnceWith({ limit: 50 });
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(chat, null, 2));
  });

  it('rejects a missing since value', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runLeaderCli(['thread', '--since'])).toBe(2);
    expect(error.mock.calls[0]?.[0]).toContain('Usage:');
  });
});
