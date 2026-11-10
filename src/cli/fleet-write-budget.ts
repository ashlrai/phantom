/** `ashlr fleet write-budget` — how many job files each lane can take right
 * now: free slots (target - running) minus what is already queued, with
 * devin and codex-local ignoring queued. The same answer the planner
 * brief's WRITE BUDGET section carries. Read-only; never writes. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planWriteBudget, writeBudgetBriefLines, writeBudgetLanesFromStatus, type WriteBudgetLaneInput } from '../core/fleet/planner-write-budget.js';
import { readSource } from '../core/fleet/runs-parked-queue.js';

const STATUS_MAX = 1024 * 1024;
const CLAUDE_MAX = 64 * 1024;
const usage = 'Usage: ashlr fleet write-budget [--json] [--runs-dir <dir>]\nOne line per lane: jobs to write now (free slots minus queued; devin and codex-local ignore queued), then a total. Reads <runs>/queue/status.json and <runs>/queue/claude-lane.state (default runs dir: ASHLR_RUNS_DIR or ~/.ashlr-runs). Read-only: writes nothing.';

export async function cmdFleetWriteBudget(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let runsDirArg: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--runs-dir' && runsDirArg === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) runsDirArg = args[++i];
    else { console.error(usage); return 2; }
  }
  const runsDir = runsDirArg ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const [status, claude] = await Promise.all([
    readSource(join(runsDir, 'queue', 'status.json'), STATUS_MAX, false),
    readSource(join(runsDir, 'queue', 'claude-lane.state'), CLAUDE_MAX, false),
  ]);
  if (status.state !== 'healthy') { console.error(`error: cannot read queue/status.json under ${runsDir} (${status.state})`); return 1; }
  let lanes: WriteBudgetLaneInput[];
  try {
    lanes = writeBudgetLanesFromStatus(JSON.parse(status.text));
  } catch { console.error(`error: invalid queue/status.json under ${runsDir}`); return 1; }
  const plan = planWriteBudget(lanes, { claudeLane: claude.text.trim() });
  console.log(json ? JSON.stringify(plan) : writeBudgetBriefLines(plan).join('\n'));
  return 0;
}
