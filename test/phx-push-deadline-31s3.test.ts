import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEEDS_YOU_SOURCES } from '../src/core/verse/workbench-types.js';
import { createRemotePushWatcher } from '../src/core/web/remote-push-watcher.js';

const sources = Object.fromEntries(NEEDS_YOU_SOURCES.map((source) => [source, 'ok']));
const activity = (cursor: string, ids: string[] = []) => ({
  cursor, needsYou: ids.map((id) => ({ id, source: 'fleet' })), completions: [], sources,
});
const fleet = (numbers: number[] = []) => ({
  mergesLastHour: { items: numbers.map((number) => ({ repo: 'fake', number, title: 'fake change' })) },
  lanes: [], claudeLane: null,
});
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('remote push operation deadlines', () => {
  it('keeps fleet progressing during an activity hang and discards the late activity baseline', async () => {
    const stuck = deferred();
    const read = vi.fn().mockReturnValueOnce(stuck.promise)
      .mockResolvedValueOnce(activity('c1', ['old']))
      .mockResolvedValueOnce(activity('c2', ['old', 'new']));
    let snapshot = fleet();
    const send = vi.fn(async () => undefined);
    const watcher = createRemotePushWatcher({ read, readFleet: async () => snapshot, send, timeoutMs: 25 });
    const first = watcher.pollOnce();
    expect(await watcher.pollOnce()).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect(await first).toBe(false);
    snapshot = fleet([1]);
    expect(await watcher.pollOnce()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('fleet-merged', { count: 1, detail: '#1 fake change' });
    stuck.resolve(activity('stale', ['late']));
    await vi.advanceTimersByTimeAsync(0);
    expect(await watcher.pollOnce()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await watcher.pollOnce()).toBe(true);
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, null, 'c1']);
    expect(send).toHaveBeenLastCalledWith('needs-you');
  });

  it('keeps activity progressing during a fleet hang and discards the late fleet baseline', async () => {
    const stuck = deferred();
    const readFleet = vi.fn().mockResolvedValueOnce(fleet()).mockReturnValueOnce(stuck.promise)
      .mockResolvedValueOnce(fleet([1])).mockResolvedValueOnce(fleet([1, 2]));
    let current = activity('c1');
    const read = vi.fn(async () => current);
    const send = vi.fn(async (_kind: string, _detail?: unknown) => undefined);
    const watcher = createRemotePushWatcher({ read, readFleet, send, timeoutMs: 25 });
    await watcher.pollOnce();
    current = activity('c2', ['new']);
    const second = watcher.pollOnce();
    await vi.advanceTimersByTimeAsync(25);
    expect(await second).toBe(true);
    current = activity('c3', ['new', 'newer']);
    expect(await watcher.pollOnce()).toBe(true);
    expect(readFleet).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([kind]) => kind)).toEqual(['needs-you', 'needs-you']);
    stuck.resolve(fleet([99]));
    await vi.advanceTimersByTimeAsync(0);
    await watcher.pollOnce();
    await watcher.pollOnce();
    expect(send.mock.calls.slice(2)).toEqual([
      ['fleet-merged', { count: 1, detail: '#1 fake change' }],
      ['fleet-merged', { count: 1, detail: '#2 fake change' }],
    ]);
  });

  it('does not let a late activity response regress an established cursor or known work', async () => {
    const stuck = deferred();
    const read = vi.fn().mockResolvedValueOnce(activity('c1', ['old']))
      .mockReturnValueOnce(stuck.promise)
      .mockResolvedValueOnce(activity('c2', ['old', 'new']))
      .mockResolvedValueOnce(activity('c3', ['old', 'new']));
    const send = vi.fn(async () => undefined);
    const watcher = createRemotePushWatcher({ read, send, timeoutMs: 25 });
    await watcher.pollOnce();
    const second = watcher.pollOnce();
    await vi.advanceTimersByTimeAsync(25);
    expect(await second).toBe(false);
    stuck.resolve(activity('stale', []));
    await vi.advanceTimersByTimeAsync(0);
    await watcher.pollOnce();
    await watcher.pollOnce();
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'c1', 'c1', 'c2']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('needs-you');
  });

  it('serializes simultaneous activity and fleet notifications without dropping settled sends', async () => {
    const firstSend = deferred();
    const send = vi.fn().mockReturnValueOnce(firstSend.promise).mockResolvedValue(undefined);
    let current = activity('c1');
    let snapshot = fleet();
    const watcher = createRemotePushWatcher({ read: async () => current, readFleet: async () => snapshot, send, timeoutMs: 25 });
    await watcher.pollOnce();
    current = activity('c2', ['new']);
    snapshot = fleet([1]);
    const poll = watcher.pollOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    firstSend.resolve(undefined);
    await poll;
    expect(send.mock.calls.map(([kind]) => kind)).toEqual(['needs-you', 'fleet-merged']);
  });

  it('releases a hung send, skips overlapping sends, and does not replay missed notifications', async () => {
    const stuck = deferred();
    let current = activity('c1');
    const send = vi.fn().mockReturnValueOnce(stuck.promise).mockResolvedValue(undefined);
    const watcher = createRemotePushWatcher({ read: async () => current, send, timeoutMs: 25 });
    await watcher.pollOnce();
    current = activity('c2', ['a']);
    const second = watcher.pollOnce();
    await vi.advanceTimersByTimeAsync(25);
    expect(await second).toBe(true);
    current = activity('c3', ['a', 'b']);
    expect(await watcher.pollOnce()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    stuck.reject(new Error('fake late failure'));
    await vi.advanceTimersByTimeAsync(0);
    await watcher.pollOnce();
    expect(send).toHaveBeenCalledTimes(1);
    current = activity('c4', ['a', 'b', 'c']);
    await watcher.pollOnce();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('clears owned timers on stop, releases the poll, and ignores late results', async () => {
    const stuck = deferred();
    const read = vi.fn().mockReturnValueOnce(stuck.promise).mockResolvedValue(activity('fresh'));
    const watcher = createRemotePushWatcher({ read, send: async () => undefined, timeoutMs: 25 });
    watcher.start();
    expect(vi.getTimerCount()).toBe(2);
    watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(await watcher.pollOnce()).toBe(false);
    stuck.resolve(activity('stale'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await watcher.pollOnce()).toBe(true);
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, null]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the polling lock until ordinary operations settle', async () => {
    const waiting = deferred();
    const read = vi.fn(() => waiting.promise);
    const watcher = createRemotePushWatcher({ read, send: async () => undefined, timeoutMs: 25 });
    const first = watcher.pollOnce();
    expect(await watcher.pollOnce()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    waiting.resolve(activity('c1'));
    expect(await first).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])('rejects invalid timeout %s', (timeoutMs) => {
    expect(() => createRemotePushWatcher({ read: async () => null, send: async () => undefined, timeoutMs }))
      .toThrow('Invalid remote push operation timeout');
  });
});
