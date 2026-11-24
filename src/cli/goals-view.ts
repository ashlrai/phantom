/**
 * `phm goals [--json]`: the fleet scorecard. Plain words by default, behind
 * first; `--json` prints the versioned `fleet.goal-scorecard.v3` object for
 * agents (`--text` is kept as an alias of the default). Thin:
 * core/fleet/goal-scorecard.ts reads and judges. Exit 0 even when signals are
 * unknown; unknown is an answer, not a failure.
 */
import { readGoalScorecard, renderGoalScorecard, type ReadGoalScorecardOptions } from '../core/fleet/goal-scorecard.js';

const USAGE = 'Usage: phm goals [--json]';

export async function cmdGoals(args: string[], opts: ReadGoalScorecardOptions = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  if (args.some(arg => arg !== '--json' && arg !== '--text') || (json && args.includes('--text'))) { console.error(USAGE); return 2; }
  const card = await readGoalScorecard(opts);
  console.log(json ? JSON.stringify(card, null, 2) : renderGoalScorecard(card));
  return 0;
}
