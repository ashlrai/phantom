import { readFailureReason } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { postReleaseHold } from '../fleet-lanes/lane-hold-release.js';
import { isLaneTargets } from '../ops/lane-targets-model.js';
import { parseReleaseCommand } from './composer-text.js';

export async function runReleaseCommand(draft: string): Promise<{ ok: boolean; text: string }> {
  const command = parseReleaseCommand(draft);
  if (!command) return { ok: false, text: 'Use /release <lane> [reason] to release a lane hold.' };
  if ('error' in command) return { ok: false, text: command.error };
  try {
    const result = await postReleaseHold(command.lane, command.reason);
    if (!isLaneTargets(result)) return { ok: false, text: 'The server returned an invalid lane response.' };
    const row = result.lanes.find(item => item.lane === command.lane);
    if (!row || row.held) return { ok: false, text: 'The server did not confirm the lane release.' };
    return { ok: true, text: `Released ${row.lane}.` };
  } catch (error) {
    return { ok: false, text: error instanceof VerseControlLockedError ? error.message : readFailureReason(error) };
  }
}
