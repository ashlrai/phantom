/** Preview recovery of work whose publication aborted after a fork push. Read-only. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readFleetRepublish } from '../core/fleet/republish.js';

const usage = 'Usage: phm fleet republish [--dry-run] [--runs-dir <dir>] [--json]';
export async function cmdFleetRepublish(args: string[], reader = readFleetRepublish): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(`${usage}\nPreview only. One recovery line per job; unavailable evidence stays unknown.`); return 0; }
  let values;
  try { ({ values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean' }, 'runs-dir': { type: 'string' }, json: { type: 'boolean' } } })); }
  catch { console.error(usage); return 2; }
  try {
    const report = await reader(values['runs-dir'] ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
    console.log(values.json ? JSON.stringify(report) : report.jobs.map(row => row.readyLine ?? `${row.job}: ${row.status} (pr_state: ${row.pr_state}) — ${row.reason}`).join('\n') || 'No publish logs found.');
    return report.status === 'unknown' ? 1 : 0;
  } catch {
    const error = { schema: 'fleet.republish.v1', readOnly: true, status: 'unknown', reason: 'Publish directory is unreadable.', jobs: null };
    console.log(values.json ? JSON.stringify(error) : `unknown — ${error.reason}`); return 1;
  }
}
