import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetNotificationStoreForTests,
  enableDesktopNotifications,
  getNotificationSnapshot,
  reconcileNotifications,
} from './notification-store.js';
import { saveQuietHours } from './quiet-hours.js';
import type { AppNotification } from './types.js';

/**
 * Recovery coverage for the quiet-hours desktop hold (t1628u/t1631u,
 * recut of #4821 via #5121): routine banners are held inside the configured
 * local window — including windows spanning midnight — and released as ONE
 * summary notification when the window ends. Hard-limit asks (secrets,
 * money, outside-send, destroy-data) still come through immediately, and
 * with quiet hours unset the store behaves exactly as before.
 *
 * Everything runs against the real store with a fake clock and a stubbed
 * Notification global; no real desktop notification is ever raised.
 */
describe('quiet-hours recovery (store behavior)', () => {
  const delivered: string[] = [];

  function routine(id: string, title = `Routine ${id}`): AppNotification {
    return { id, category: 'fleet', severity: 'high', title, detail: 'detail', ts: '' };
  }

  function hardAsk(id: string): AppNotification {
    return {
      id,
      category: 'action-required',
      severity: 'high',
      title: 'Approve billing payment',
      detail: 'needs your decision',
      ts: '',
    };
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 23, 30));
    localStorage.clear();
    __resetNotificationStoreForTests();
    delivered.length = 0;
    class FakeNotification {
      static permission = 'granted';
      onclick: ((this: Notification, ev: Event) => unknown) | null = null;
      constructor(title: string) {
        delivered.push(title);
      }
      addEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    await enableDesktopNotifications();
  });

  afterEach(() => {
    __resetNotificationStoreForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds routine banners across a midnight-spanning window, then flushes one summary', () => {
    saveQuietHours({ start: '22:00', end: '07:00' });

    // 23:30 — inside the window: eligible routine items stay in the centre
    // but raise no desktop banner.
    reconcileNotifications([routine('fleet-merge:1', 'Merged change A')]);
    expect(delivered).toEqual([]);
    expect(getNotificationSnapshot().items.map((n) => n.id)).toContain('fleet-merge:1');

    // 02:00 next day — still inside the wrap-around window: the minute-boundary
    // recheck fires, sees quiet hours, and holds again without delivering.
    vi.setSystemTime(new Date(2026, 0, 2, 2, 0));
    vi.advanceTimersByTime(60_000);
    reconcileNotifications([routine('fleet-merge:1', 'Merged change A'), routine('run-failed:r_9', 'Run failed')]);
    expect(delivered).toEqual([]);

    // 07:00 — window end is exclusive: the pending check flushes BOTH held
    // items as a single summary banner.
    vi.setSystemTime(new Date(2026, 0, 2, 7, 0));
    vi.advanceTimersByTime(60_000);
    expect(delivered).toEqual(['2 updates while quiet']);

    // Exactly-once: re-deriving the same items neither re-sends the summary
    // nor raises the held banners retroactively.
    reconcileNotifications([routine('fleet-merge:1', 'Merged change A'), routine('run-failed:r_9', 'Run failed')]);
    expect(delivered).toEqual(['2 updates while quiet']);
  });

  it('delivers routine banners immediately when quiet hours are unset', () => {
    // No saveQuietHours call — default/disabled settings keep prior behavior.
    reconcileNotifications([routine('fleet-merge:1', 'Merged change A')]);
    expect(delivered).toEqual(['Merged change A']);
  });

  it('keeps hard-limit asks audible while routine items are held', () => {
    saveQuietHours({ start: '22:00', end: '07:00' });
    reconcileNotifications([routine('fleet-merge:1', 'Merged change A'), hardAsk('ask-1')]);
    // The money ask bypasses the quiet window; the routine merge is held.
    expect(delivered).toEqual(['Approve billing payment']);
    expect(getNotificationSnapshot().items).toHaveLength(2);
  });
});
