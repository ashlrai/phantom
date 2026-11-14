/** Fixed, read-only status answer for a verified owner's short "status" ask. */
import { isStatusAsk } from '../fleet/status-ask.js';
import { buildStatusDigest } from '../leader/status-digest.js';
import { gatherStatusDigestInput } from '../leader/status-digest-sources.js';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { listWorkBoard, type WorkBoardResult } from '../comms/work-board.js';
import { summarizeWorkBoard, WORK_BOARD_UNKNOWN_LINE } from '../comms/work-board-summary.js';

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

export interface OwnerStatusDeps {
  brief?: (runsDir: string, now: Date) => Promise<string>;
  /** Work-board read; the default scans the durable bus inbox under ~/.ashlr/fleet. */
  board?: (now: Date) => WorkBoardResult;
}

const defaultBoard = (now: Date): WorkBoardResult => listWorkBoard({ root: join(ashlrHome(), 'fleet'), now: now.getTime(), limit: 20 });

/** A failed board read never touches the digest: it only becomes the "unknown" line. */
function workLines(now: Date, board: OwnerStatusDeps['board']): string[] {
  try { return summarizeWorkBoard((board ?? defaultBoard)(now), now); } catch { return [WORK_BOARD_UNKNOWN_LINE]; }
}

/** Never throws: a failed read still tells the owner where the ask went.
 * The digest has priority: work-board lines are appended whole, or dropped last-first. */
export async function composeOwnerStatusReply(runsDir: string, now: Date, deps: OwnerStatusDeps = {}): Promise<string> {
  try {
    const brief = await (deps.brief ?? digestBrief)(runsDir, now);
    const text = brief.replace(/^Morning leader brief/, `Phantom status, ${easternClock(now)} ET`);
    const lines = workLines(now, deps.board);
    while (lines.length > 0 && [text, ...lines].join('\n').length > MAX_REPLY_CHARS) lines.pop();
    const full = [text, ...lines].join('\n');
    return full.length > MAX_REPLY_CHARS ? `${full.slice(0, MAX_REPLY_CHARS - 1)}…` : full;
  } catch { return OWNER_STATUS_FALLBACK; }
}

/** The fixed auto-answer the Slack socket wiring injects into the Leader adapter.
 * Imported only by non-closure modules (cli + tests), so the digest readers stay
 * outside the Tier-1 import closure that slack-leader.ts belongs to. */
export function ownerStatusReply(deps: OwnerStatusDeps = {}): { ask: (text: string) => boolean; compose: (runsDir: string, now: Date) => Promise<string>; readonly fallback: string } {
  return { ask: isOwnerStatusRequest, compose: (runsDir, now) => composeOwnerStatusReply(runsDir, now, deps), fallback: OWNER_STATUS_FALLBACK };
}
