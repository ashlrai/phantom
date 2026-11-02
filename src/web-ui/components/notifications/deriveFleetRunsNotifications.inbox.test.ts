import { describe, expect, it, vi } from 'vitest';
import { deriveFleetRunsNotifications as derive } from './deriveFleetRunsNotifications.js';
import { __resetNotificationStoreForTests, enableDesktopNotifications, getNotificationSnapshot, reconcileNotifications } from './notification-store.js';

const now = Date.parse('2026-10-31T11:45:00Z'); // 07:45 Eastern
const entry = (at = '2026-10-31 07:31', source = 'desktop', text = 'Please check the fleet') => ({ at, source, text });
const snapshot = (inbox: unknown[], leaders: unknown[] = [{ label: 'leader', ageSeconds: 300 }]) => ({
  generatedAt: new Date(now).toISOString(), paused: false, claudeLane: null,
  lanes: [], workers: [{ ageSeconds: 60 }], mergesLastHour: { count: 0 }, drop: null, events: [], inbox, leaders,
});

describe('fleet inbox notifications', () => {
  it('announces a read in Eastern time and sanitizes the preview', () => {
    const text = `  Please check /fake/private/file\nfor status ${'x'.repeat(90)}  `;
    const [notification] = derive(snapshot([entry(undefined, 'desktop', text)]), now);
    expect(notification).toMatchObject({ category: 'fleet', severity: 'critical',
      title: 'Your 07:31 message was read by the 07:40 leader pass',
      detail: 'Please check … for status …' });
    expect(notification?.id).toMatch(/^fleet-inbox-read:2026-10-31 07:31:[a-z0-9]+$/);
  });

  it('waits for a strictly newer pass and supports phone sources', () => {
    expect(derive(snapshot([entry('2026-10-31 07:40', 'phone')]), now)).toEqual([]);
    expect(derive(snapshot([entry('2026-10-31 07:41', 'mobile')]), now)).toEqual([]);
    expect(derive(snapshot([entry('2026-10-31 07:31', 'phone')]), now)[0]?.severity).toBe('critical');
  });

  it('announces a 30 minute wait without a newer pass, even with no leader', () => {
    const pending = entry('2026-10-31 07:15');
    for (const leaders of [[], [{ label: 'leader', ageSeconds: 1800 }], [{ label: 'leader', ageSeconds: null }]]) {
      expect(derive(snapshot([pending], leaders), now)).toMatchObject([{ id: 'fleet-inbox-overdue:2026-10-31 07:15',
        severity: 'medium', title: 'Your 07:15 message has waited 30 min for a leader pass' }]);
    }
    expect(derive(snapshot([entry('2026-10-31 07:16')], []), now)).toEqual([]);
    expect(derive(snapshot([pending], [{ label: 'leader', ageSeconds: 1200 }]), now)[0]?.id).toMatch(/^fleet-inbox-read:/);
  });

  it('skips relayed and system sources, invalid, future, and 25 hour old entries', () => {
    const entries = [entry(undefined, 'leader'), entry(undefined, 'system'), entry(undefined, 'leader for Mason'),
      entry(undefined, 'worker'), entry('2026-10-30 06:45'), entry('bad'), entry('2026-10-31 07:46')];
    expect(derive(snapshot(entries), now)).toEqual([]);
  });

  it('keeps ids stable across polls and distinguishes messages posted in the same minute', () => {
    const data = snapshot([entry(), entry(undefined, 'telegram', 'A different message')]);
    const ids = derive(data, now).map(n => n.id);
    expect(new Set(ids).size).toBe(2);
    expect(derive(data, now + 1000).map(n => n.id)).toEqual(ids);
  });

  it('reconciles the same read once and sends one native notification', async () => {
    const notification = vi.fn();
    class FakeNotification {
      static permission = 'granted';
      constructor(title: string, options: NotificationOptions) { notification(title, options); }
    }
    vi.stubGlobal('Notification', FakeNotification);
    __resetNotificationStoreForTests();
    try {
      await enableDesktopNotifications();
      const data = snapshot([entry()]);
      reconcileNotifications(derive(data, now));
      reconcileNotifications(derive(data, now + 1000));
      expect(getNotificationSnapshot().items).toHaveLength(1);
      expect(notification).toHaveBeenCalledTimes(1);
      expect(notification).toHaveBeenCalledWith('Your 07:31 message was read by the 07:40 leader pass',
        expect.objectContaining({ body: 'Please check the fleet' }));
    } finally {
      __resetNotificationStoreForTests();
      vi.unstubAllGlobals();
    }
  });
});
