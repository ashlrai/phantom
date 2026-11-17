/**
 * Shared identity derivation between the Leader reply producer
 * (`leader-network.ts`), the Slack send store (`slack-transport.ts`) and the
 * evidence readers (`slack-reply-binding.ts`). This is a leaf module so none of
 * them has to copy the others' hashing assumptions or import each other.
 *
 * A Leader request id is `sha256([channel, envelope.id])`. Its reply is sent as
 * the envelope `leader-reply-<first 32 hex of the request id>`, and the send
 * store keys each row by `sha256(envelope.id)`. The resulting key is
 * correlation evidence that the stored send was produced for that request. It
 * is not proof that the reply content answered it.
 */
import { createHash } from 'node:crypto';

export const SLACK_REQUEST_ID_PATTERN = /^[a-f0-9]{64}$/;

export const isSlackRequestId = (value: unknown): value is string =>
  typeof value === 'string' && SLACK_REQUEST_ID_PATTERN.test(value);

/** A send-store key is the same 64-hex digest shape. */
export const isSlackSendStoreKey = isSlackRequestId;

/** Bus envelope id of the Leader reply to `requestId`. */
export function leaderReplyEnvelopeId(requestId: string): string {
  return `leader-reply-${requestId.slice(0, 32)}`;
}

/** Key of one outbound envelope in the Slack send store (`messages.json`). */
export function slackSendStoreKey(envelopeId: string): string {
  return createHash('sha256').update(envelopeId).digest('hex');
}

/** Send-store key under which the Leader reply to `requestId` is recorded. */
export function leaderReplySendKey(requestId: string): string {
  return slackSendStoreKey(leaderReplyEnvelopeId(requestId));
}
