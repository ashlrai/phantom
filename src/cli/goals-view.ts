/**
 * `phm goals [--json|--text]`: the fleet scorecard. JSON by default for agents,
 * `--text` for people. Thin: core/fleet/goal-scorecard.ts reads and judges.
 * Exit 0 even when signals are unknown; unknown is an answer, not a failure.
 */
import { readGoalScorecard, renderGoalScorecard, type ReadGoalScorecardOptions } from '../core/fleet/goal-scorecard.js';

const USAGE = 'Usage: phm goals [--json|--text]';

export async function cmdGoals(args: string[], opts: ReadGoalScorecardOptions = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  const text = args.includes('--text');
  if (args.some(arg => arg !== '--json' && arg !== '--text') || (text && args.includes('--json'))) { console.error(USAGE); return 2; }
  const card = await readGoalScorecard(opts);
  console.log(text ? renderGoalScorecard(card) : JSON.stringify(card, null, 2));
  return 0;
}
