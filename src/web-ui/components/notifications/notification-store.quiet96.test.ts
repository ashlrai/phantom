import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetNotificationStoreForTests, enableDesktopNotifications, getNotificationSnapshot, reconcileNotifications } from './notification-store.js';
import { saveQuietHours } from './quiet-hours.js';
import type { AppNotification } from './types.js';

describe('quiet desktop notifications', () => {
  const delivered: string[] = [];
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59));
    localStorage.clear();
    __resetNotificationStoreForTests();
    delivered.length = 0;
    class FakeNotification {
      static permission = 'granted';
      constructor(title: string) { delivered.push(title); }
      addEventListener() { /* no-op */ }
    }
    vi.stubGlobal('Notification', FakeNotification);
    await enableDesktopNotifications();
    saveQuietHours({ start: '22:00', end: '00:00' });
  });
  afterEach(() => { __resetNotificationStoreForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('holds routine items in the center, delivers hard asks, then sends one summary', () => {
    const merge: AppNotification = { id: 'fleet-merge:1', category: 'fleet', severity: 'high', title: 'Merged', detail: 'Change', ts: '' };
    const ask: AppNotification = { ...merge, id: 'ask', category: 'action-required', title: 'Approve billing payment' };
    reconcileNotifications([merge, ask]);
    expect(getNotificationSnapshot().items).toHaveLength(2);
    expect(delivered).toEqual(['Approve billing payment']);
    vi.advanceTimersByTime(60_000);
    expect(delivered).toEqual(['Approve billing payment', '1 update while quiet']);
    reconcileNotifications([merge, ask]);
    expect(delivered).toHaveLength(2);
  });
});
