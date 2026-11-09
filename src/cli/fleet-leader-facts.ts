import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeLeaderFacts } from '../core/fleet/leader-facts.js';

export async function cmdFleetLeaderFacts(args: string[]): Promise<number> {
  if (args.length && !(args.length === 1 && args[0] === '--json')) { console.error('Usage: ashlr fleet leader-facts [--json]'); return 2; }
  try { const facts = await writeLeaderFacts(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs')); console.log(args.length ? JSON.stringify(facts) : `Wrote leader/facts.json (${facts.jobs.length} jobs).`); return 0; }
  catch { console.error('Could not write leader facts.'); return 1; }
}
