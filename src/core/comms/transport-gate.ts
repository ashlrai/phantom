/**
 * KILL and comms pause, checked by every outside transport (iMessage, Telegram,
 * Mail.app) itself rather than trusted to its callers. Both read from the
 * account home (util/real-home.ts), so a child with a relocated HOME cannot
 * see them as clear.
 *
 * Fails closed: any error reading either state blocks the send. Owner-only
 * alerts are blocked during KILL too, pending Mason's decision (docs/COMMS-AGENT.md).
 */
import { isPaused } from './pause.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { isolatedAuthorityHomeActive } from '../util/real-home.js';

/** A refusal reason, or null when the send may proceed. Never throws. */
export function outsideSendBlock(): string | null {
  try {
    // A demo's throwaway authority home has no real KILL or pause to consult.
    if (isolatedAuthorityHomeActive()) return 'Outside sends are off in an isolated demo.';
    if (killSwitchOn()) return 'Kill switch is on.';
    if (isPaused()) return 'Communications are paused.';
    return null;
  } catch {
    return 'Kill switch or pause state could not be read.';
  }
}
