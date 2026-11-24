/**
 * `ashlr fleet leader-seat` - where the leader runs, which seat it moves to when its pool runs out, and, at 98% used or after two usage-limit failures, the one-line wrapper change for Security (written to leader/drafts/).
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readSeatSwap, seatSwapText, writeSeatSwapDraft, type SeatSwapView } from '../core/fleet/leader-seat-swap.js';

export const usage = 'Usage: ashlr fleet leader-seat [--json] [--runs-dir <abs>]';

export interface FleetLeaderSeatDeps { read?: (runsDir: string) => Promise<SeatSwapView>; write?: typeof writeSeatSwapDraft }

/** Exit 0 with a seat for the next pass or none needed, 3 when no seat is usable, 2 on bad usage. */
export async function cmdFleetLeaderSeat(args: string[], deps: FleetLeaderSeatDeps = {}): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(usage); return 0; }
  let runsDir = process.env['ASHLR_RUNS_DIR'] || join(homedir(), '.ashlr-runs'), json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && args[i + 1] !== undefined && isAbsolute(args[i + 1]!) && !args[i + 1]!.includes('\0')) runsDir = args[++i]!;
    else { console.error(usage); return 2; }
  }
  const view = await (deps.read ?? (dir => readSeatSwap({ runsDir: dir })))(runsDir);
  let draft: string | null = null;
  try { draft = await (deps.write ?? writeSeatSwapDraft)(view, runsDir); } catch { /* the proposal still prints */ }
  console.log(json ? JSON.stringify({ ...view, draft }) : [seatSwapText(view), ...(draft ? [`Saved for Security: ${draft}`] : [])].join('\n'));
  return view.runsNext ? 0 : 3;
}
