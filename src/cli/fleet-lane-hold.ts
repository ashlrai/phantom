/**
 * `ashlr fleet lane-hold` — headless placement of a bounded, self-expiring
 * lane hold through the same guarded slots.json path releaseLaneHold uses.
 * When a lane burns jobs on dead credentials this is how an agent stops it:
 * no hand-editing queue/slots.json. --minutes is capped at 1440 (24 h) so a
 * Phantom hold always expires — dispatchd enforces held_until. A row a
 * person holds (held_by not 'autobackoff', not 'phantom…') is refused
 * manual-hold and never overwritten.
 */
import { isAbsolute } from 'node:path';
import { placeLaneHold } from '../core/fleet/runs-lane-hold-place.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet lane-hold <lane> --minutes <n> --reason <text> [--runs-dir <abs>] [--json]
Places a bounded hold on a lane: --minutes is an integer 1..1440 (24 h max —
the hold always expires) and --reason is printable ASCII, 1..120 chars. A
hold a person placed is refused (manual-hold), never overwritten. Exit 1 on
a LaneHoldError, 2 on usage.`;

interface Dependencies {
  now?: () => Date;
  changedBy?: string;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

/** The escaped, home-scrubbed spelling of one value for human output. */
const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value))
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export async function cmdFleetLaneHold(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, lane: string | undefined, minutesArg: string | undefined, reason: string | undefined, runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--minutes' && minutesArg === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !/^\d+$/.test(value)) return invalid();
      minutesArg = value;
    } else if (arg === '--reason' && reason === undefined) {
      const value = args[++i];
      if (typeof value !== 'string') return invalid();
      reason = value;
    } else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else if (!arg.startsWith('-') && lane === undefined) lane = arg;
    else return invalid();
  }
  const minutes = Number(minutesArg);
  if (lane === undefined || reason === undefined || !Number.isSafeInteger(minutes)) return invalid();
  try {
    const state = await placeLaneHold(lane, { runsDir, minutes, reason, now: deps.now, changedBy: deps.changedBy });
    if (json) output(JSON.stringify(sanitizePublicJson(state)));
    else {
      const row = state.lanes.find((entry) => entry.lane === lane);
      output(row === undefined
        ? `fleet lane-hold: ${safe(lane)} placed`
        : `${safe(row.lane)} held=${row.held} heldReason=${safe(row.heldReason)} heldUntil=${safe(row.heldUntil)}`);
    }
    return 0;
  } catch (err) {
    error(`fleet lane-hold failed: ${safe(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}
