/** `phm jobs stranded`: pushed branches whose publication aborted at the default-branch fetch. Read-only. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readStrandedBranches } from '../core/fleet/stranded-branches.js';

const usage = 'Usage: phm jobs stranded [--runs-dir <dir>] [--json]';
export async function cmdJobsStranded(args: string[], reader = readStrandedBranches): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nWhich pushed branches never got a PR because publishing aborted at the default-branch fetch (ABORT default-fetch). Prints one idempotent recovery command per stranded branch; jobs whose PR already exists are listed as recovered. Reads <runs dir>/*.publish only. JSON: jobs.stranded.v1. Exit 1 when a log is unreadable.`);
    return 0;
  }
  let values;
  try { ({ values } = parseArgs({ args, options: { 'runs-dir': { type: 'string' }, json: { type: 'boolean' } } })); }
  catch { console.error(usage); return 2; }
  try {
    const report = await reader(values['runs-dir'] ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
    if (values.json) console.log(JSON.stringify(report));
    else {
      console.log(report.branches.map(row => `${row.job}\t${row.branch}\t${row.recover}`).join('\n') || 'No stranded branches.');
      if (report.recovered.length) console.log(`already recovered: ${report.recovered.map(row => row.job).join(', ')}`);
      if (report.unreadable.length) console.log(`unknown — unreadable logs: ${report.unreadable.join(', ')}`);
    }
    return report.status === 'unknown' ? 1 : 0;
  } catch {
    const error = { schema: 'jobs.stranded.v1', readOnly: true, status: 'unknown', reason: 'Publish directory is unreadable.', branches: null, recovered: null, unreadable: null };
    console.log(values.json ? JSON.stringify(error) : `unknown — ${error.reason}`);
    return 1;
  }
}
