/** Fixed, read-only status answer for a verified owner's short "status" ask. */
import { isStatusAsk } from '../fleet/status-ask.js';
import { buildStatusDigest } from '../leader/status-digest.js';
import { gatherStatusDigestInput } from '../leader/status-digest-sources.js';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { listWorkBoard, type WorkBoardResult } from '../comms/work-board.js';
import { summarizeWorkBoard, WORK_BOARD_UNKNOWN_LINE } from '../comms/work-board-summary.js';
import { isRecheckAsk } from '../fleet/recheck-ask.js';
import { readFleetRecheck } from '../fleet/fleet-recheck.js';
import { formatRecheckReply } from '../fleet/fleet-recheck-reply.js';

/** The five-line digest from real state; the heading is swapped for the clock below. */
const digestBrief = async (runsDir: string, now: Date): Promise<string> =>
  ['Morning leader brief', ...buildStatusDigest(await gatherStatusDigestInput(runsDir, now))].join('\n');
const MAX_REPLY_CHARS = 1500;
export const OWNER_STATUS_FALLBACK = "Phantom status: the status read failed; your message is in the Leader's inbox and it will answer there.";
export const OWNER_RECHECK_FALLBACK = "Phantom recheck: the recheck read failed; your message is in the Leader's inbox.";

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
  /** One sanitized runtime-identity + channel-health line (see
   * owner-status-runtime-line.ts). Opt-in: the Slack socket wiring passes
   * defaultRuntimeLine; absent or throwing means no line, never a failure. */
  runtime?: (now: Date) => Promise<string>;
  /** The paste-ready fleet recheck verdict for a short "recheck" ask; the
   * default reads the live verdict (readFleetRecheck + formatRecheckReply). */
  recheck?: (now: Date) => Promise<string>;
}

const defaultRecheck = async (now: Date): Promise<string> => formatRecheckReply(await readFleetRecheck({ now: () => now }));

/** Never throws, and never falls through to the status digest: a recheck ask
 * gets the recheck verdict or the fixed recheck fallback. Read-only; the
 * reply grants nothing. */
export async function composeOwnerRecheckReply(now: Date, deps: OwnerStatusDeps = {}): Promise<string> {
  try { return await (deps.recheck ?? defaultRecheck)(now); } catch { return OWNER_RECHECK_FALLBACK; }
}

const defaultBoard = (now: Date): WorkBoardResult => listWorkBoard({ root: join(ashlrHome(), 'fleet'), now: now.getTime(), limit: 20 });

/** A failed board read never touches the digest: it only becomes the "unknown" line. */
function workLines(now: Date, board: OwnerStatusDeps['board']): string[] {
  try { return summarizeWorkBoard((board ?? defaultBoard)(now), now); } catch { return [WORK_BOARD_UNKNOWN_LINE]; }
}

/** The runtime line is evidence, not a gate: an absent or throwing seam
 * changes nothing else in the reply. One line only — anything after the
 * first newline is dropped so it always sits directly under the heading. */
async function runtimeLine(now: Date, seam: OwnerStatusDeps['runtime']): Promise<string> {
  if (seam === undefined) return '';
  try { return (await seam(now)).split('\n', 1)[0]; } catch { return ''; }
}

/** Never throws: a failed read still tells the owner where the ask went.
 * The digest has priority: the runtime line sits directly under the heading;
 * work-board lines are dropped last-first, then the runtime line, never the
 * digest. */
export async function composeOwnerStatusReply(runsDir: string, now: Date, deps: OwnerStatusDeps = {}): Promise<string> {
  try {
    const brief = await (deps.brief ?? digestBrief)(runsDir, now);
    const text = brief.replace(/^Morning leader brief/, `Phantom status, ${easternClock(now)} ET`);
    const [heading, ...digestRest] = text.split('\n');
    const runtime = await runtimeLine(now, deps.runtime);
    const lines = workLines(now, deps.board);
    const assemble = (withRuntime: boolean): string =>
      [heading, ...(withRuntime && runtime !== '' ? [runtime] : []), ...digestRest, ...lines].join('\n');
    while (lines.length > 0 && assemble(true).length > MAX_REPLY_CHARS) lines.pop();
    const full = assemble(true);
    const dropped = runtime !== '' && full.length > MAX_REPLY_CHARS ? assemble(false) : full;
    return dropped.length > MAX_REPLY_CHARS ? `${dropped.slice(0, MAX_REPLY_CHARS - 1)}…` : dropped;
  } catch { return OWNER_STATUS_FALLBACK; }
}

/** The fixed auto-answer the Slack socket wiring injects into the Leader adapter.
 * Imported only by non-closure modules (cli + tests), so the digest readers stay
 * outside the Tier-1 import closure that slack-leader.ts belongs to. The same
 * holds for the fleet recheck readers: an exact "recheck" ask is answered with
 * the recheck verdict, every other gated ask with the status digest. */
export function ownerStatusReply(deps: OwnerStatusDeps = {}): { ask: (text: string) => boolean; compose: (runsDir: string, now: Date, text?: string) => Promise<string>; readonly fallback: string } {
  return {
    ask: text => isOwnerStatusRequest(text) || isRecheckAsk(text),
    compose: (runsDir, now, text) => text !== undefined && isRecheckAsk(text)
      ? composeOwnerRecheckReply(now, deps)
      : composeOwnerStatusReply(runsDir, now, deps),
    fallback: OWNER_STATUS_FALLBACK,
  };
}
