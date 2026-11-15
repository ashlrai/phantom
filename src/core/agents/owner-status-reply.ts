/** Fixed, read-only status answer for a verified owner's short "status" ask. */
import { isStatusAsk } from '../fleet/status-ask.js';
import { buildStatusDigest } from '../leader/status-digest.js';
import { gatherStatusDigestInput } from '../leader/status-digest-sources.js';

/** The five-line digest from real state; the heading is swapped for the clock below. */
const digestBrief = async (runsDir: string, now: Date): Promise<string> =>
  ['Morning leader brief', ...buildStatusDigest(await gatherStatusDigestInput(runsDir, now))].join('\n');
const MAX_REPLY_CHARS = 1500;
export const OWNER_STATUS_FALLBACK = "Phantom status: the status read failed; your message is in the Leader's inbox and it will answer there.";

/** Exact short asks only; "status of the release pr #12" is a request for the Leader. */
export function isOwnerStatusRequest(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  return isStatusAsk(trimmed);
}

function easternClock(now: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/** Never throws: a failed read still tells the owner where the ask went. */
export async function composeOwnerStatusReply(runsDir: string, now: Date, deps: { brief?: (runsDir: string, now: Date) => Promise<string> } = {}): Promise<string> {
  try {
    const brief = await (deps.brief ?? digestBrief)(runsDir, now);
    const text = brief.replace(/^Morning leader brief/, `Phantom status, ${easternClock(now)} ET`);
    return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1)}…` : text;
  } catch { return OWNER_STATUS_FALLBACK; }
}

/** The fixed auto-answer the Slack socket wiring injects into the Leader adapter.
 * Imported only by non-closure modules (cli + tests), so the digest readers stay
 * outside the Tier-1 import closure that slack-leader.ts belongs to. */
export function ownerStatusReply(deps: { brief?: (runsDir: string, now: Date) => Promise<string> } = {}): { ask: (text: string) => boolean; compose: (runsDir: string, now: Date) => Promise<string>; readonly fallback: string } {
  return { ask: isOwnerStatusRequest, compose: (runsDir, now) => composeOwnerStatusReply(runsDir, now, deps), fallback: OWNER_STATUS_FALLBACK };
}
