import { channelName, type ReceiptItem } from './owner-thread-lines.js';

const GROUPS: ReadonlyArray<[ReceiptItem['state'], string]> = [['delivered', 'Delivered'], ['pending', 'Pending'], ['failed', 'Failed'], ['unknown', 'Unknown']];

/** Where an outgoing Leader message went. "Unknown" means no record, never delivered. */
export function DeliveryReceipt({ items }: { items: readonly ReceiptItem[] }) {
  const parts = GROUPS.flatMap(([state, label]) => {
    const rows = items.filter(item => item.state === state);
    return rows.length ? [`${label}: ${rows.map(r => `${channelName(r.channel)}${r.reason ? ` (${r.reason})` : ''}`).join(' · ')}`] : [];
  });
  if (!parts.length) return null;
  return <p aria-label="Delivery" data-delivery-receipt style={{ margin: '4px 0 0', fontSize: 11, opacity: 0.7 }}>{parts.join('  —  ')}</p>;
}
