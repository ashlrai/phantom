import { describe, expect, it, vi } from 'vitest';
import { createRemotePushWatcher } from '../src/core/web/remote-push-watcher.js';
import { NEEDS_YOU_SOURCES } from '../src/core/verse/workbench-types.js';

describe('Leader push watcher', () => {
  it('baselines, ignores other speakers and preserves the mark across invalid reads', async () => {
    const line = (who: string, at: number, source = 'verse') => ({ who, at, source, text: `message ${at}` });
    let rows: unknown = [line('leader', 1)];
    const send = vi.fn(async () => undefined);
    const watcher = createRemotePushWatcher({
      read: async () => ({ cursor: 'c', needsYou: [], completions: [], sources: Object.fromEntries(NEEDS_YOU_SOURCES.map(s => [s, 'ok'])) }),
      readLeaderReplies: async () => rows, send,
    });
    await watcher.pollOnce();
    rows = [line('leader', 1), line('mason', 2), line('leader', 3, 'system')];
    await watcher.pollOnce();
    expect(send).not.toHaveBeenCalled();
    rows = null;
    await watcher.pollOnce();
    rows = [line('leader', 4)];
    await watcher.pollOnce();
    expect(send).toHaveBeenCalledExactlyOnceWith('leader-reply', { count: 1 });
    watcher.stop();
  });
});
