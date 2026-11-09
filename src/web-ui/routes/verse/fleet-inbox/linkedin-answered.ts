import type { UnifiedInboxEntry } from './unified-inbox-model.js';

export const LINKEDIN_ANSWERED_PATH = '/api/verse/comms/inbox/linkedin/answered';

/** The drop-folder message id of a LinkedIn row (`linkedin:<id>`), or null for any other row. */
export function linkedInMessageId(item: Pick<UnifiedInboxEntry, 'id' | 'kind'>): string | null {
  if (item.kind !== 'linkedin-message' || !item.id.startsWith('linkedin:')) return null;
  const id = item.id.slice('linkedin:'.length);
  return id.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : null;
}

export function linkedInAnsweredOutcome(status: number): string {
  if (status === 200) return 'Marked answered.';
  if (status === 401 || status === 403) return 'Unlock to mark answered.';
  return 'Could not mark answered. Try again.';
}
