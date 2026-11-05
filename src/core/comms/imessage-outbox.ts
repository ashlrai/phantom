/**
 * Self-only iMessage outbox. Third-party delivery remains denied pending the
 * separate Security-reviewed draft/send integration. Approval is not a grant
 * to bypass the transport's self check.
 */
import { isSelfIMessageHandle, sendIMessage } from '../integrations/imessage.js';
import type { AshlrConfig } from '../types.js';

export async function sendIMessageOutbox(text: string, cfg: AshlrConfig, to: string): Promise<{
  ok: boolean;
  reason?: 'not_self' | 'drafts_unavailable';
}> {
  if (!isSelfIMessageHandle(to, cfg)) return { ok: false, reason: 'drafts_unavailable' };
  return sendIMessage(text, cfg, to);
}
