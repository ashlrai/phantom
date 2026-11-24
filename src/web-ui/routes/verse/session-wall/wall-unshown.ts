/**
 * What the Conversations wall says when the session list holds more sessions
 * than one read carries. The read keeps running sessions before ended ones
 * and counts what it left out by state (`counts.unshown`), so the wall can say
 * whether anything still working is off screen, which is the case that
 * matters, apart from the ordinary one where only ended sessions are.
 * Pure: the words, their tone and whether "Running only" could help.
 */
import type { SessionWallRead, WallScope } from './session-wall-model.js';

export interface UnshownNotice {
  /** `warn` when a session that is running, or whose state is not known, is off screen. */
  tone: 'warn' | 'plain';
  text: string;
  /**
   * True when asking for running sessions only could bring more of them on screen: only for a read that does not count
   * what it left out. One that does has already given every ended session's place to a running one.
   */
  offerRunning: boolean;
}

const sessions = (n: number, word = '') => `${n} ${word ? `${word} ` : ''}session${n === 1 ? '' : 's'}`;
const are = (n: number) => (n === 1 ? 'is' : 'are');

/** Null when the read holds every session in the list, and when it did not say how many the list holds. */
export function unshownNotice(read: Pick<SessionWallRead, 'total' | 'entries' | 'unshown'>, scope: WallScope): UnshownNotice | null {
  const held = read.entries.length, missing = read.total === null ? 0 : read.total - held;
  if (missing <= 0) return null;
  const left = read.unshown;
  // A server that does not count them by state: the number is known, what they are doing is not.
  if (left === null || left.running + left.ended + left.unknown === 0) {
    // Asked for running sessions only, the list holds nothing else.
    if (scope.live) return { tone: 'warn', offerRunning: false, text: `${sessions(missing, 'running')} ${are(missing)} not on this screen. The wall holds ${held}; a lane or a repo brings them on.` };
    return { tone: 'warn', offerRunning: true, text: `${sessions(missing)} ${are(missing)} not on this screen, and this read does not say whether any of them is running.` };
  }
  const rest = [left.ended > 0 && `${left.ended} ended`, left.unknown > 0 && `${left.unknown} with state unknown`].filter(Boolean).join(', ');
  if (left.running > 0) {
    return { tone: 'warn', offerRunning: false,
      text: `${sessions(left.running, 'running')} ${are(left.running)} not on this screen${rest ? `, and ${rest}` : ''}. The wall holds ${held}; a lane or a repo brings them on.` };
  }
  if (left.unknown > 0) {
    return { tone: 'warn', offerRunning: false,
      text: `${sessions(left.unknown)} with state unknown ${are(left.unknown)} not on this screen${left.ended > 0 ? `, and ${left.ended} ended` : ''}. Every session known to be running is here.` };
  }
  return { tone: 'plain', offerRunning: false, text: `Every running session is here. ${sessions(left.ended, 'ended')} ${are(left.ended)} not: the wall holds ${held}, and a lane or a repo brings them on.` };
}

/** The read's own sentence for the same fact, which the notice replaces at the foot of the wall. */
export const isUnshownGap = (gap: string) => /^\d+ more sessions? not shown\b/.test(gap);
