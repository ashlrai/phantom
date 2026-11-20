/** `phm jobs stranded`: pushed branches whose publication aborted at the default-branch fetch. Read-only. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseSinceHours, readStrandedBranches } from '../core/fleet/stranded-branches.js';

const usage = 'Usage: phm jobs stranded [--since 24h] [--runs-dir <dir>] [--json]';
export async function cmdJobsStranded(args: string[], reader = readStrandedBranches): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nFinished jobs that pushed their branch but never got a PR because publishing aborted afterwards (e.g. ABORT default-fetch). One row per job: job, repo, branch, age, files changed and one next step; unknown stays unknown. Jobs whose PR was created later are listed as recovered. Reads <runs dir>/*.publish only; never pushes, opens PRs or deletes. JSON: jobs.stranded.v1. Exit 1 when a log is unreadable.`);
    return 0;
  }
  let values;
  try { ({ values } = parseArgs({ args, options: { since: { type: 'string' }, 'runs-dir': { type: 'string' }, json: { type: 'boolean' } } })); }
  catch { console.error(usage); return 2; }
  const sinceHours = values.since === undefined ? null : parseSinceHours(values.since);
  if (values.since !== undefined && sinceHours === null) { console.error(`${usage}\n--since takes a number and m, h or d, like 24h.`); return 2; }
  try {
    const report = await reader(values['runs-dir'] ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), { sinceHours });
    if (values.json) console.log(JSON.stringify(report));
    else {
      const unknown = (v: string | number | null, unit = ''): string => (v === null ? 'unknown' : `${v}${unit}`);
      console.log(report.branches.map(row => `${row.job}\t${unknown(row.repo)}\t${row.branch}\t${unknown(row.ageHours, 'h old')}\t${unknown(row.filesChanged, ' files')}\t${row.next}`).join('\n') || 'No stranded branches.');
      if (report.recovered.length) console.log(`already recovered: ${report.recovered.map(row => row.job).join(', ')}`);
      if (report.unreadable.length) console.log(`unknown — unreadable logs: ${report.unreadable.join(', ')}`);
    }
    return report.status === 'unknown' ? 1 : 0;
  } catch {
    const error = { schema: 'jobs.stranded.v1', sinceHours, readOnly: true, status: 'unknown', reason: 'Publish directory is unreadable.', branches: null, recovered: null, unreadable: null };
    console.log(values.json ? JSON.stringify(error) : `unknown — ${error.reason}`);
    return 1;
  }
}
