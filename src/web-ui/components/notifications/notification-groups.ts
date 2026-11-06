import { NOTIFICATION_CATEGORY_LABEL, type AppNotification, type NotificationCategory, type NotificationSeverity } from './types.js';

type NotificationGroup = {
  category: NotificationCategory;
  label: string;
  count: number;
  urgent: number;
  items: AppNotification[];
};

const severityRank: Record<NotificationSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function groupNotifications(items: readonly AppNotification[]): NotificationGroup[] {
  const groups = new Map<NotificationCategory, NotificationGroup>();
  for (const item of items) {
    let group = groups.get(item.category);
    if (!group) {
      group = { category: item.category, label: NOTIFICATION_CATEGORY_LABEL[item.category], count: 0, urgent: 0, items: [] };
      groups.set(item.category, group);
    }
    group.items.push(item);
    group.count++;
    if (item.severity === 'critical' || item.severity === 'high') group.urgent++;
  }
  const mostSevere = (group: NotificationGroup) => group.items.reduce((rank, item) => Math.min(rank, severityRank[item.severity]), Infinity);
  return [...groups.values()].sort((a, b) => mostSevere(a) - mostSevere(b) || b.count - a.count);
}

export function groupHeading(group: NotificationGroup): string {
  return `${group.label} · ${group.count}${group.urgent ? ` (${group.urgent} urgent)` : ''}`;
}
