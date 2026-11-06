import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetNotificationStoreForTests,
  enableDesktopNotifications,
  getNotificationSnapshot,
  reconcileNotifications,
} from './notification-store.js';
import type { AppNotification } from './types.js';

class FakeNotification {
  static instances: FakeNotification[] = [];
  static permission: NotificationPermission = 'default';
  static requestPermission: () => Promise<NotificationPermission>;
  onclick: ((this: Notification, ev: Event) => unknown) | null = null;
  closed = false;
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

describe('notification-store desktop clicks', () => {
  beforeEach(() => {
    FakeNotification.instances = [];
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission = vi.fn(async () => {
      FakeNotification.permission = 'granted';
      return FakeNotification.permission;
    });
    __resetNotificationStoreForTests();
    vi.stubGlobal('Notification', FakeNotification);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetNotificationStoreForTests();
  });

  it('attaches an onclick that focuses the console and routes to the action hash', async () => {
    await enableDesktopNotifications();
    const item: AppNotification = {
      id: 'fleet-stalled',
      category: 'fleet',
      severity: 'high',
      title: 'Fleet stalled',
      detail: 'No worker progress for 30 minutes.',
      ts: new Date().toISOString(),
      actionHref: '/verse/fleet',
    };
    reconcileNotifications([item]);

    expect(FakeNotification.instances).toHaveLength(1);
    const raised = FakeNotification.instances[0]!;
    expect(raised.title).toBe('Fleet stalled');
    expect(typeof raised.onclick).toBe('function');

    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    (raised.onclick as unknown as (ev: Event) => unknown).call(raised, new Event('click'));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/verse/fleet');
    expect(raised.closed).toBe(true);
    expect(getNotificationSnapshot().panelOpen).toBe(false);
  });
});
