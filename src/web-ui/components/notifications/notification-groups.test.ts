import { describe, expect, it } from 'vitest';
import { groupHeading, groupNotifications } from './notification-groups.js';
import type { AppNotification, NotificationCategory, NotificationSeverity } from './types.js';

function item(id: string, category: NotificationCategory, severity: NotificationSeverity): AppNotification {
  return { id, category, severity, title: id, detail: 'Details', ts: '2026-01-01T00:00:00Z' };
}

describe('groupNotifications', () => {
  it('orders by the most severe item, then count, and preserves item order', () => {
    const items = [
      item('fleet-low', 'fleet', 'low'),
      item('security-high', 'security', 'high'),
      item('fleet-critical', 'fleet', 'critical'),
      item('budget-high-1', 'budget', 'high'),
      item('budget-high-2', 'budget', 'high'),
      item('fleet-high', 'fleet', 'high'),
      item('budget-info', 'budget', 'info'),
    ];
    const groups = groupNotifications(items);
    expect(groups.map((group) => group.category)).toEqual(['fleet', 'budget', 'security']);
    expect(groups.map(({ count, urgent }) => ({ count, urgent }))).toEqual([
      { count: 3, urgent: 2 }, { count: 3, urgent: 2 }, { count: 1, urgent: 1 },
    ]);
    expect(groups[0].items.map(({ id }) => id)).toEqual(['fleet-low', 'fleet-critical', 'fleet-high']);
    expect(groupHeading(groups[0])).toBe('Fleet on this Mac · 3 (2 urgent)');
  });

  it('returns no groups for empty input and omits zero urgent from headings', () => {
    expect(groupNotifications([])).toEqual([]);
    expect(groupHeading(groupNotifications([item('run', 'run', 'info')])[0])).toBe('Runs · 1');
  });
});
