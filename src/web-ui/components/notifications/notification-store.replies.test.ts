import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetNotificationStoreForTests,
  enableDesktopNotifications,
  reconcileNotifications,
  setMuted,
  wantsDesktopNotification,
} from './notification-store.js';
import type { AppNotification } from './types.js';

class FakeNotification {
  static instances: FakeNotification[] = [];
  static permission: NotificationPermission = 'granted';
  onclick: ((this: Notification, ev: Event) => unknown) | null = null;
  constructor(public title: string, public options?: NotificationOptions) {
    FakeNotification.instances.push(this);
  }
  close(): void {}
}

function row(id: string): AppNotification {
  return { id, category: 'fleet', severity: 'info', title: 'A reply', detail: 'Fake reply text', ts: '2026-01-01T00:00:00Z' };
}

describe('desktop reply notifications', () => {
  beforeEach(() => {
    FakeNotification.instances = [];
    FakeNotification.permission = 'granted';
    vi.stubGlobal('Notification', FakeNotification);
    __resetNotificationStoreForTests();
  });
  afterEach(() => {
    __resetNotificationStoreForTests();
    vi.unstubAllGlobals();
  });

  it('notifies once for a Leader reply and preserves its click action', async () => {
    await enableDesktopNotifications();
    const actionRun = vi.fn();
    const reply = { ...row('leader-reply:t3'), actionRun };
    reconcileNotifications([reply]);
    reconcileNotifications([reply]);
    expect(FakeNotification.instances).toHaveLength(1);
    const notification = FakeNotification.instances[0]!;
    expect(notification.title).toBe(reply.title);
    expect(notification.options?.tag).toBe(reply.id);
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    notification.onclick?.call(notification as unknown as Notification, new Event('click'));
    expect(actionRun).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it('does not notify for the backlog summary or unrelated info', async () => {
    await enableDesktopNotifications();
    reconcileNotifications([row('leader-reply:more'), row('fleet-drop-pending')]);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('notifies for a bus reply', async () => {
    await enableDesktopNotifications();
    reconcileNotifications([row('bus-reply:abc')]);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.options?.tag).toBe('bus-reply:abc');
  });

  it('respects a muted fleet category for both replies', async () => {
    await enableDesktopNotifications();
    setMuted('fleet', true);
    reconcileNotifications([row('leader-reply:t3'), row('bus-reply:abc')]);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('requires desktop notifications to be enabled', () => {
    reconcileNotifications([row('leader-reply:t3'), row('bus-reply:abc')]);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('requires granted permission even after enabling', async () => {
    await enableDesktopNotifications();
    FakeNotification.permission = 'denied';
    reconcileNotifications([row('leader-reply:t3'), row('bus-reply:abc')]);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it.each([
    ['leader-reply:t3', true], ['leader-reply:more', false], ['bus-reply:abc', true],
    ['fleet-merge:abc', true], ['fleet-lane-released-abc', true], ['fleet-drop-pending', false],
  ])('eligibility for %s is %s', (id, eligible) => {
    expect(wantsDesktopNotification(row(id))).toBe(eligible);
  });
});
