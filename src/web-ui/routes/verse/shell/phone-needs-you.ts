import type { FleetNeedsYouItem } from './fleet-needs-you.js';

// Settings is a section, so the row resolves this destination to its Connection anchor.
export const PHONE_CONNECTION_PANE = 'settings-connection';
const APPROVAL_ID = /^[0-9a-f-]{36}$/;

export function derivePhoneNeedsYou(pending: unknown): FleetNeedsYouItem[] {
  if (!pending || typeof pending !== 'object') return [];
  const data = pending as Record<string, unknown>;
  if (data.v !== 1 || data.gateway !== 'running' || !Array.isArray(data.approvals)) return [];
  return data.approvals.flatMap((entry: unknown): FleetNeedsYouItem[] => {
    if (!entry || typeof entry !== 'object') return [];
    const approval = entry as Record<string, unknown>;
    if (typeof approval.id !== 'string' || !APPROVAL_ID.test(approval.id)
      || typeof approval.label !== 'string' || !approval.label.trim()
      || typeof approval.email !== 'string' || !approval.email.trim()
      || typeof approval.subject !== 'string' || !approval.subject.trim()) return [];
    return [{
      id: `phone-pending:${approval.id}`,
      severity: 'attention',
      title: 'Phone waiting for your approval',
      detail: `${approval.label} · ${approval.email}`,
      nextStep: 'Approve or deny it in Settings › Connection',
      target: 'settings',
      open: { kind: 'pane', paneId: PHONE_CONNECTION_PANE },
    }];
  });
}
