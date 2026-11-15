import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../data/cache.js';
import { leaderThreadQuery } from '../../routes/verse/leader/thread-data.js';
import { resetVerseUi } from '../../routes/verse/verse-ui-store.js';
import { LEADER_REPLY_MARK_STORAGE_KEY } from './leader-reply-mark-store.js';
import { __resetNotificationStoreForTests, getNotificationSnapshot } from './notification-store.js';
import { useNotificationEngine } from './useNotificationEngine.js';

function Harness() { useNotificationEngine(); return null; }

const NOW = '2026-11-09T12:00:00Z';
const msg = (id: string, from: 'leader' | 'mason', at: string, text: string) => ({ id, at, from, channel: 'desktop', kind: 'message', text });
let thread: ReturnType<typeof msg>[] = [];
const sources: Record<string, unknown> = {
  '/api/control': { ts: NOW, security: { available: true, findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 } },
    limits: [], daemon: { sourceQuality: { sourceState: 'healthy', complete: true } } },
  '/api/fleet': { nextActions: [] }, '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
};
const mine = () => getNotificationSnapshot().items.filter(item => item.id.startsWith('leader-reply:'));

describe('leader-reply notification engine', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW));
    // Another window has focus: Mason is not reading the Leader view.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    localStorage.removeItem(LEADER_REPLY_MARK_STORAGE_KEY);
    markCheckComplete(false);
    evictAll();
    __resetNotificationStoreForTests();
    resetVerseUi();
    markCheckComplete(true);
    thread = [msg('t1', 'leader', '2026-11-09T11:00:00Z', 'old answer'), msg('t2', 'mason', '2026-11-09T11:01:00Z', 'question')];
    vi.stubGlobal('fetch', vi.fn(async (path: string) =>
      path.startsWith('/api/verse/leader/thread') ? Response.json({ messages: thread })
        : Response.json(sources[path] ?? null)));
  });
  afterEach(() => { markCheckComplete(false); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('seeds silently, then reconciles exactly the one new reply', async () => {
    await act(async () => { render(<Harness />); });
    expect(mine()).toEqual([]);
    thread = [...thread, msg('t3', 'leader', '2026-11-09T11:30:00Z', '**Shipped** it')];
    await act(async () => { await refetchQuery(leaderThreadQuery.key, () => leaderThreadQuery.fetch(), true); });
    expect(mine()).toEqual([expect.objectContaining({ id: 'leader-reply:t3', title: 'Leader replied', detail: 'Shipped it' })]);
    await act(async () => { await refetchQuery(leaderThreadQuery.key, () => leaderThreadQuery.fetch(), true); });
    expect(mine()).toHaveLength(1);
  });
});
