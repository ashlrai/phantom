import { LANE_ID_RE } from '../fleet/runs-lane-targets.js';

/**
 * /target <lane> <nonnegative-integer> — set an existing lane's worker target
 * from Mason's private chat, through the same setLaneTarget core as desktop,
 * phone and `ashlr fleet lane-target`. The lane is only shape-checked here:
 * membership and floor/ceiling bounds stay the core's call (unknown-lane /
 * out-of-range), so a Telegram command can never widen a lane's envelope or
 * create a lane the dispatcher does not already know. The target must be a
 * plain safe-integer digit string: no sign, no decimal, no exponent.
 */
export function parseTargetCommand(text: string): { lane: string; target: number } | null {
  const match = /^\s*\/target(?:@\w+)?\s+(\S+)\s+(\d+)\s*$/i.exec(text);
  const lane = match?.[1];
  const target = match?.[2] === undefined ? NaN : Number(match[2]);
  return lane !== undefined && LANE_ID_RE.test(lane) && Number.isSafeInteger(target) && target >= 0
    ? { lane, target }
    : null;
}

export type TargetReply =
  | { status: 'set'; lane: string; target: number; held: boolean }
  | { status: 'failed'; reason: 'unknown-lane' | 'out-of-range' | 'unavailable' };

/** Only fixed failure messages are exposed; filesystem and provider errors may contain secrets. */
export function renderTargetReply(result: TargetReply): string {
  if (result.status === 'set') {
    return `${result.lane} target set to ${result.target}.${result.held ? ' Its hold remains active — the target applies when it lifts.' : ''}`;
  }
  const reason = { 'unknown-lane': 'lane is unavailable', 'out-of-range': 'target is outside the lane bounds', unavailable: 'lane targets unavailable' }[result.reason];
  return `Target not set: ${reason}.`;
}
