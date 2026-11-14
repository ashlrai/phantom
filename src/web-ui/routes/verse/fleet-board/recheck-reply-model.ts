import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** Mirrors REPLY_MAX in core/fleet/fleet-recheck-reply.ts; never truncated client-side. */
export const REPLY_MAX = 900;

/**
 * Local shape of GET /api/verse/fleet/recheck?reply=1. Declared here on
 * purpose: the web bundle must not import src/core.
 */
export interface RecheckReplyResp { reply?: unknown }

/** `null` = the route (or the `reply` option) is absent on this build. */
export const recheckReplyQuery: QueryDef<RecheckReplyResp | null> = {
  key: 'verse-fleet-recheck-reply',
  async fetch(signal) {
    try { return await apiGet<RecheckReplyResp>('/api/verse/fleet/recheck?reply=1', signal); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

export type ReplyPreviewState = 'loading' | 'absent' | 'unreadable' | 'ready';
export interface ReplyPreview { state: ReplyPreviewState; text: string }

/** `undefined` = loading; `null`/'error' = absent; anything else is validated, not trusted. */
export function deriveReplyPreview(resp: RecheckReplyResp | null | 'error' | undefined): ReplyPreview {
  if (resp === undefined) return { state: 'loading', text: 'Loading thread reply…' };
  if (resp === null || resp === 'error') return { state: 'absent', text: 'Thread reply is not on this Phantom build' };
  const reply = typeof resp === 'object' ? resp.reply : undefined;
  if (typeof reply !== 'string' || reply === '' || reply.length > REPLY_MAX) {
    return { state: 'unreadable', text: 'Thread reply is unreadable' };
  }
  return { state: 'ready', text: reply };
}
