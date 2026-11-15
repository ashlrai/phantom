import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LEADER_THREAD_POLL_MS, watchLeaderThread } from '../src/core/web/leader-thread-watch.js';

type Listener = (event: string, filename: string | null) => void;

function fakeWatch() {
  const state = { listener: null as Listener | null, closed: 0, dir: '' };
  const watch = ((dir: string, _opts: unknown, listener: Listener) => {
    state.dir = dir;
    state.listener = listener;
    return { close: () => { state.closed += 1; }, on: () => undefined };
  }) as never;
  return { state, watch };
}

describe('watchLeaderThread', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('collapses rapid changes into one onChange and ignores unrelated files', () => {
    const { state, watch } = fakeWatch();
    const onChange = vi.fn();
    const stop = watchLeaderThread(onChange, { path: '/x/leader/thread.jsonl', debounceMs: 100, watch });
    expect(state.dir).toBe('/x/leader');
    state.listener!('change', 'thread-index.json');
    state.listener!('change', 'memos');
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    state.listener!('change', 'thread.jsonl');
    state.listener!('change', 'thread.jsonl');
    state.listener!('rename', 'thread.1.jsonl');
    vi.advanceTimersByTime(99);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('shares one watcher and closes it with the last unsubscribe', () => {
    const { state, watch } = fakeWatch();
    const opts = { path: '/y/leader/thread.jsonl', watch };
    const a = vi.fn();
    const b = vi.fn();
    const stopA = watchLeaderThread(a, opts);
    const stopB = watchLeaderThread(b, opts);
    state.listener!('change', 'thread.jsonl');
    vi.advanceTimersByTime(250);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    stopA();
    stopA();
    expect(state.closed).toBe(0);
    stopB();
    expect(state.closed).toBe(1);
  });

  describe('with a throwing fs.watch', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'leader-watch-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('falls back to a stat-mtime poll', () => {
      const path = join(dir, 'thread.jsonl');
      writeFileSync(path, '{}\n');
      const watch = (() => { throw new Error('ENOENT'); }) as never;
      const onChange = vi.fn();
      const stop = watchLeaderThread(onChange, { path, debounceMs: 10, watch });
      vi.advanceTimersByTime(LEADER_THREAD_POLL_MS + 20);
      expect(onChange).not.toHaveBeenCalled();
      writeFileSync(path, '{}\n{}\n');
      utimesSync(path, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      vi.advanceTimersByTime(LEADER_THREAD_POLL_MS + 20);
      expect(onChange).toHaveBeenCalledTimes(1);
      stop();
      writeFileSync(path, 'changed again, longer\n');
      vi.advanceTimersByTime(LEADER_THREAD_POLL_MS * 2);
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });
});
