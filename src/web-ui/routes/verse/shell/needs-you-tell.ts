import type { FleetNeedsYouItem } from './fleet-needs-you.js';

export function tellLeadersPrefill(item: Pick<FleetNeedsYouItem, 'title' | 'detail' | 'nextStep'>): string {
  const title = item.title.trim().replace(/\s+/g, ' ');
  const detail = item.detail.trim().replace(/\s+/g, ' ').replace(/\.+$/, '');
  const prefill = `Re "${title}": ${detail}. `;
  return prefill.length <= 400 ? prefill : `${prefill.slice(0, 399).trimEnd()}…`;
}
