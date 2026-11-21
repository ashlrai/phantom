/** `phm jobs stranded`: pushed branches whose publication aborted at the default-branch fetch. Read-only. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseSinceHours, readStrandedBranches } from '../core/fleet/stranded-branches.js';

const usage = 'Usage: phm jobs stranded [--since 24h] [--runs-dir <dir>] [--requeue [--apply]] [--json]';
export async function cmdJobsStranded(args: string[], reader = readStrandedBranches): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nFinished jobs that pushed their branch but never got a PR because publishing aborted afterwards (e.g. ABORT default-fetch). One row per job: job, repo, branch, age, files changed and one next step; unknown stays unknown. Jobs whose PR was created later are listed as recovered. Reads <runs dir>/*.publish only; never pushes, opens PRs or deletes. --requeue plans one recovery row per fetch-race job (id <job>R2, then R3, then gave up) and prints it; --apply writes the prompt file and the ready.tsv row (claude lane, work tier; gh work only on the gh lane, or listed as deferred) and skips ids already queued. Other abort reasons are listed, never requeued. JSON: jobs.stranded.v1 (jobs.stranded.requeue.v1 with --requeue). Exit 1 when a log is unreadable.`);
    return 0;
  }
  let values;
  try { ({ values } = parseArgs({ args, options: { since: { type: 'string' }, 'runs-dir': { type: 'string' }, json: { type: 'boolean' }, requeue: { type: 'boolean' }, apply: { type: 'boolean' } } })); }
  catch { console.error(usage); return 2; }
  const sinceHours = values.since === undefined ? null : parseSinceHours(values.since);
  if (values.since !== undefined && sinceHours === null) { console.error(`${usage}\n--since takes a number and m, h or d, like 24h.`); return 2; }
  if (values.apply && !values.requeue) { console.error(`${usage}\n--apply goes with --requeue.`); return 2; }
  if (values.requeue) {
    try {
      const { planStrandedRequeue, requeueText, readGhLaneSlots } = await import('../core/fleet/stranded-requeue.js');
      const plan = await planStrandedRequeue(values['runs-dir'] ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), { apply: values.apply === true, sinceHours, ghSlots: readGhLaneSlots });
      console.log(values.json ? JSON.stringify(plan) : requeueText(plan).join('\n'));
      return plan.status === 'unknown' ? 1 : 0;
    } catch {
      console.log(values.json ? JSON.stringify({ schema: 'jobs.stranded.requeue.v1', status: 'unknown', reason: 'Publish directory is unreadable.' }) : 'unknown — Publish directory is unreadable.');
      return 1;
    }
  }
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
