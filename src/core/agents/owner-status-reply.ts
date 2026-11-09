/** Fixed, read-only status answer for a verified owner's short "status" ask. */
import { leaderDailyBrief } from '../comms/leader-daily-brief.js';

const STATUS_ASKS = new Set(['status', 'phantom status', 'fleet status', '/status', "what's the status", 'whats the status']);
const MAX_REPLY_CHARS = 1500;
export const OWNER_STATUS_FALLBACK = "Phantom status: the status read failed; your message is in the Leader's inbox and it will answer there.";

/** Exact short asks only; "status of the release pr #12" is a request for the Leader. */
export function isOwnerStatusRequest(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return STATUS_ASKS.has(ask);
}

function easternClock(now: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/** Never throws: a failed read still tells the owner where the ask went. */
export async function composeOwnerStatusReply(runsDir: string, now: Date, deps: { brief?: (runsDir: string, now: Date) => Promise<string> } = {}): Promise<string> {
  try {
    const brief = await (deps.brief ?? leaderDailyBrief)(runsDir, now);
    const text = brief.replace(/^Morning leader brief/, `Phantom status, ${easternClock(now)} ET`);
    return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1)}…` : text;
  } catch { return OWNER_STATUS_FALLBACK; }
}
