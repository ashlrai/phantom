import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetNotificationStoreForTests,
  enableDesktopNotifications,
  reconcileNotifications,
} from './notification-store.js';
import { saveQuietHours } from './quiet-hours.js';
import type { AppNotification } from './types.js';

// Disabling quiet hours through the settings path flushes held routine banners
// as ONE summary; hard-limit asks never wait. Fake clock + fake Notification.
describe('quiet-hours disable flush (production store)', () => {
  const delivered: string[] = [];
  const routine = (id: string): AppNotification =>
    ({ id, category: 'fleet', severity: 'high', title: `Routine ${id}`, detail: 'd', ts: '' });
  const hardAsk: AppNotification =
    { id: 'ask', category: 'action-required', severity: 'high', title: 'Approve billing payment', detail: 'needs you', ts: '' };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 23, 30));
    localStorage.clear();
    __resetNotificationStoreForTests();
    delivered.length = 0;
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      onclick = null;
      constructor(title: string) { delivered.push(title); }
      addEventListener(): void {}
      close(): void {}
    });
    await enableDesktopNotifications();
  });

  afterEach(() => {
    __resetNotificationStoreForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('flushes pending routine notifications exactly once; hard asks stay immediate', () => {
    saveQuietHours({ start: '22:00', end: '07:00' });
    reconcileNotifications([routine('a'), routine('b'), hardAsk]);
    expect(delivered).toEqual(['Approve billing payment']);

    saveQuietHours(null);
    expect(delivered).toEqual(['Approve billing payment', '2 updates while quiet']);

    saveQuietHours(null);
    vi.advanceTimersByTime(120_000);
    reconcileNotifications([routine('a'), routine('b'), hardAsk]);
    expect(delivered).toHaveLength(2);
  });
});
