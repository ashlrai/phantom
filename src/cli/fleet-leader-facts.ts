import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeLeaderFacts } from '../core/fleet/leader-facts.js';

const usage = 'Usage: ashlr fleet leader-facts [--json]';

export async function cmdFleetLeaderFacts(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args.length && !(args.length === 1 && args[0] === '--json')) { console.error(usage); return 2; }
  try { const facts = await writeLeaderFacts(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs')); console.log(args.length ? JSON.stringify(facts) : `Wrote leader/facts.json (${facts.jobs.length} jobs).`); return 0; }
  catch { console.error('Could not write leader facts.'); return 1; }
}
