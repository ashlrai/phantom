import { createHash } from 'node:crypto';
import { leaderReplySendKey } from '../../src/core/agents/slack-reply-identity.js';

/** Deterministic fake Leader request id (64 hex). Real ids come from leader-network; see the round-trip test. */
export const fakeRequestId = (label: string | number): string =>
  createHash('sha256').update(`slack-causal-fixture:${label}`).digest('hex');

/** Send-store key the real producer chain assigns to the Leader reply for this request id. */
export const replyKey = (requestId: string): string => leaderReplySendKey(requestId);

/** A persisted send-store row shaped like slack-transport's (digest/clientId are opaque here). */
export const storeRow = (row: { channel: string; thread?: string; state: 'attempted' | 'sent'; ts?: string }) => ({
  digest: 'd'.repeat(64), clientId: '00000000-0000-4000-8000-000000000000', expiresAt: 4_102_444_800_000, ...row,
});
