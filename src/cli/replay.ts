import { loadJobTimeline } from '../core/run/job-replay.js';
import { runReplay } from '../tui/replay.js';

const HELP = 'Usage: phantom replay <job-id> [--once]\nView recorded tool calls, edits and checks from ~/.ashlr/run-streams/<job-id>.log.\nRead-only; j/k or arrows scroll, q quits. --once prints the full timeline.';
export async function cmdReplay(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== '--once') || args[0].startsWith('-')) {
    console.error(HELP); return 2;
  }
  try { return await runReplay(loadJobTimeline(args[0]), args[1] === '--once'); } catch {
    console.error('Replay log unavailable or invalid.'); return 1;
  }
}
