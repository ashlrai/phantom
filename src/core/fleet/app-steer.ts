/**
 * Steer the leader agents from the app or the CLI: one message into Mason's
 * inbox through the shared channel receiver, the same path as the web steer
 * box (POST /api/verse/fleet/runs/inbox) and `phm comms inbox post`. The
 * receiver scrubs secret shapes, dedupes, writes the inbox entry and mirrors
 * it onto the agent bus. Identity belongs to this adapter (the local process
 * owner), never to the message text.
 */
import { createChannelReceiver } from './channel-envelope.js';
import { INBOX_MAX_CHARS } from './mason-inbox.js';

const LOCAL_OPERATOR = 'local-operator';

export type AppSteerResult =
  | { ok: true; status: 'accepted' | 'duplicate'; channel: 'cli'; dedupeKey: string; at: string; publish: string }
  | { ok: false; reason: string };

export async function steerLeaders(text: string, options: { runsDir?: string } = {}): Promise<AppSteerResult> {
  const body = text.trim();
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > INBOX_MAX_CHARS) return { ok: false, reason: 'too-long' };
  const receive = createChannelReceiver({ allowedSenderIds: new Set([LOCAL_OPERATOR]), runsDir: options.runsDir });
  const result = await receive({ channel: 'cli', verifiedSenderId: LOCAL_OPERATOR, body });
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true, status: result.ack.status, channel: 'cli', dedupeKey: result.ack.dedupeKey,
    at: result.envelope.receivedAt, publish: result.publishState ?? 'skipped',
  };
}
