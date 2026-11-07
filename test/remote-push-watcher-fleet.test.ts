import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemotePushWatcher } from '../src/core/web/remote-push-watcher.js';
import { NEEDS_YOU_SOURCES } from '../src/core/verse/workbench-types.js';

describe('fleet polling', () => {
  afterEach(() => vi.useRealTimers());
  it('baselines both routes and preserves fleet state across a 500', async () => {
    vi.useFakeTimers();
    let items: Array<{ repo: string; number: number; title: string }> = [];
    let failed = false;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/fleet/runs')) return new Response(JSON.stringify({
        mergesLastHour: { items }, lanes: [], claudeLane: null,
      }), { status: failed ? 500 : 200 });
      return Response.json({ cursor: 'c1', needsYou: [], completions: [],
        sources: Object.fromEntries(NEEDS_YOU_SOURCES.map((source) => [source, 'ok'])) });
    });
    const read = async (path: string) => {
      const response = await fetch('http://127.0.0.1:3000/api/verse/' + path);
      if (!response.ok) throw new Error('Unavailable');
      return response.json();
    };
    const send = vi.fn(async () => undefined);
    const watcher = createRemotePushWatcher({
      read: () => read('activity'), readFleet: () => read('fleet/runs'), send,
    });
    try {
      watcher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(send).not.toHaveBeenCalled();
      items = [{ repo: 'phantom', number: 1719, title: 'bridge: work' }];
      await vi.advanceTimersByTimeAsync(15_000);
      expect(send).toHaveBeenCalledExactlyOnceWith('fleet-merged', { count: 1, detail: '#1719 bridge: work' });
      failed = true;
      items = [{ repo: 'phantom', number: 1720, title: 'next' }, ...items];
      await vi.advanceTimersByTimeAsync(15_000);
      expect(send).toHaveBeenCalledTimes(1);
      failed = false;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(send).toHaveBeenLastCalledWith('fleet-merged', { count: 1, detail: '#1720 next' });
      expect(send).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3000/api/verse/fleet/runs');
    } finally { watcher.stop(); }
  });
});
