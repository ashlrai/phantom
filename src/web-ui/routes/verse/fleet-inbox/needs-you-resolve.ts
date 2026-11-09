import type { UnifiedInboxEntry } from './unified-inbox-model.js';

export const NEEDS_YOU_RESOLVE_PATH = '/api/verse/agent-bus/needs-mason/resolve';

export function needsYouLedgerId(item: Pick<UnifiedInboxEntry, 'id' | 'kind'>): string | null {
  if (item.kind !== 'needs-you' || !item.id.startsWith('needs-you:')) return null;
  const id = item.id.slice('needs-you:'.length);
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : null;
}

export function needsYouResolveOutcome(status: number, _body: unknown): string {
  if (status === 200) return 'Resolved.';
  if (status === 409) return 'Already resolved.';
  if (status === 404) return 'No longer on the list.';
  if (status === 503) return 'The Needs-you ledger is unavailable. Try again.';
  return 'Could not resolve. Try again.';
}
