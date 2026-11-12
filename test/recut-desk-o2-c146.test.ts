import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchLeaderThread } from '../src/core/web/leader-thread-watch.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, stimulus?: () => void, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  while (Date.now() < deadline) {
    if (cond()) return;
    if (stimulus && tick++ % 4 === 0) stimulus();
    await sleep(25);
  }
  throw new Error('timed out waiting for condition');
}

// The recovered server half of PR #4359: the SSE `leader-thread` topic is fed
// by watchLeaderThread, so a write to thread.jsonl (or its rotated sibling)
// from another process wakes the desktop console within the debounce window.
describe('watchLeaderThread through its real fs.watch (recovered PR #4359)', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('fires onChange for thread.jsonl and its rotated sibling', { timeout: 20_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), 'recut-c146-'));
    const path = join(dir, 'thread.jsonl');
    const rotated = join(dir, 'thread.1.jsonl');
    let n = 0;
    writeFileSync(path, '{"v":1}\n');
    const onChange = vi.fn();
    const stop = watchLeaderThread(onChange, { path, debounceMs: 40 });
    try {
      // Repeat the write: a real fs.watch can report slightly after arming.
      await waitFor(() => onChange.mock.calls.length >= 1, () => writeFileSync(path, `{"v":${++n}}\n`));
      expect(onChange).toHaveBeenCalled();
      const beforeRotation = onChange.mock.calls.length;
      await waitFor(() => onChange.mock.calls.length > beforeRotation, () => writeFileSync(rotated, `rotated ${++n}\n`));
      expect(onChange.mock.calls.length).toBeGreaterThan(beforeRotation);
    } finally {
      stop();
    }
  });

  it('fans out to every subscriber and stops firing once the last one unsubscribes', { timeout: 20_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), 'recut-c146-'));
    const path = join(dir, 'thread.jsonl');
    let n = 0;
    writeFileSync(path, '{"v":1}\n');
    const a = vi.fn();
    const b = vi.fn();
    const stopA = watchLeaderThread(a, { path, debounceMs: 40 });
    const stopB = watchLeaderThread(b, { path, debounceMs: 40 });
    const poke = () => writeFileSync(path, `{"v":${++n}}\n`);
    await waitFor(() => a.mock.calls.length >= 1 && b.mock.calls.length >= 1, poke);
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    stopA();
    stopB();
    const settledA = a.mock.calls.length;
    const settledB = b.mock.calls.length;
    writeFileSync(path, 'after unsubscribe\n');
    await sleep(300);
    expect(a).toHaveBeenCalledTimes(settledA);
    expect(b).toHaveBeenCalledTimes(settledB);
  });
});
