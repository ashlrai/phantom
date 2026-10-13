import { describe, expect, it, beforeEach } from 'vitest';
import { swr, invalidateSwr, resetSwrForTests } from '../src/core/util/swr-cache.js';

describe('swr cache', () => {
  beforeEach(() => resetSwrForTests());
  it('cold waits, fresh hits, stale returns at once and refreshes once', async () => {
    let t = 0; let calls = 0;
    const fn = async () => { calls++; return calls; };
    const o = { ttlMs: 100, now: () => t, dir: null };
    expect(await swr('k', fn, o)).toBe(1);
    t = 50; expect(await swr('k', fn, o)).toBe(1); expect(calls).toBe(1);
    t = 500; expect(await swr('k', fn, o)).toBe(1); // stale served instantly
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(await swr('k', fn, o)).toBe(2);
    invalidateSwr('k'); expect(await swr('k', fn, o)).toBe(3);
  });
});
