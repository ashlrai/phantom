/**
 * routes/verse/fleet-direct/direct-box-model.ts: the direct box's send step.
 * Pure of React: one line in, one P0 interjection to the leaders on the agent
 * bus out. It reuses the bus post pipeline (`buildMasonEnvelope`, `postBusEnvelope`,
 * `postOutcomeText`) so the direct box and the bus pane cannot disagree about
 * the envelope, the dedupe key or the status wording.
 */
import { postBusEnvelope } from '../fleet-bus/agent-bus-post.js';
import { buildMasonEnvelope, canPost, postOutcomeText, type PostOutcome } from '../fleet-bus/bus-post-model.js';

/** The leaders' address on the agent bus (see bus-targets-model). */
export const DIRECT_TARGET = 'leaders';

export interface DirectResult { outcome: PostOutcome; message: string; ok: boolean }

export const canSendDirect = (text: string, sending: boolean) => canPost(text, DIRECT_TARGET, sending);

export async function sendDirect(text: string, now: number = Date.now()): Promise<DirectResult> {
  let outcome: PostOutcome;
  try { outcome = await postBusEnvelope(buildMasonEnvelope({ to: DIRECT_TARGET, text, now })); }
  catch { outcome = { status: 'unavailable' }; }
  return { outcome, message: postOutcomeText(outcome.status, outcome.cursor), ok: outcome.status === 'posted' || outcome.status === 'duplicate' };
}
