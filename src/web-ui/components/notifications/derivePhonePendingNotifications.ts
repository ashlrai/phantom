import { setVerseSection } from '../../routes/verse/verse-ui-store.js';
import type { PhonePendingApproval } from './phone-pending-query.js';
import type { AppNotification } from './types.js';

const openConnection = (): void => setVerseSection('settings', 'fleet-sources');

export function derivePhonePendingNotifications({ approvals, nowMs }: {
  approvals: readonly PhonePendingApproval[] | null | undefined;
  nowMs: number;
}): AppNotification[] {
  return (approvals ?? []).map(({ id, label, email, deviceType }) => ({
    id: `phone-pending:${id}`,
    category: 'action-required',
    severity: 'high',
    title: 'Phone waiting for approval',
    detail: `${label} (${email || deviceType || 'device'}) registered a passkey. Approve it in Settings > Connection.`,
    ts: new Date(nowMs).toISOString(),
    actionLabel: 'Open Connection',
    actionRun: openConnection,
  }));
}
