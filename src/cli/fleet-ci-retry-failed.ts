import { planCiRetryFailed } from '../core/fleet/ci-retry-failed.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-retry-failed --repo <owner/repo> --run <id> [--apply] [--json]';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Retries only the failed jobs of a completed run's latest attempt; the default is a plan. */
export async function cmdFleetCiRetryFailed(args: string[], deps: { gh?: GitRunner } = {}): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (!['--repo', '--run'].includes(arg) || values.has(arg) || !args[i + 1]) {
      process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? '';
  const rawRun = values.get('--run') ?? '';
  const run = /^\d+$/.test(rawRun) ? Number(rawRun) : null;
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--') ||
      repo.endsWith('/.') || repo.endsWith('/..') ||
      run === null || !Number.isSafeInteger(run) || run < 1) {
    process.stderr.write(`Invalid repository or run. ${USAGE}\n`); return 2;
  }
  const report = await planCiRetryFailed(repo, run, { apply, runner: deps.gh });
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`CI retry-failed ${report.repo} run ${run}: ${report.outcome} (${report.reason})`);
    console.log(`  Attempt: ${report.attempt ?? 'unknown'}; head: ${report.headSha ?? 'unknown'}; status: ${report.runStatus ?? 'unknown'}; conclusion: ${report.conclusion ?? 'unknown'}`);
    if (report.retry.count) console.log(`  Retry candidates (${report.retry.count}): ${report.retry.names.join(', ')}`);
    console.log(`  Preserved passing: ${report.preserved.count}${report.preserved.names.length ? ` (${report.preserved.names.join(', ')})` : ''}`);
    if (report.untouched.count) console.log(`  Untouched non-failed: ${report.untouched.count} (${report.untouched.names.join(', ')})`);
    if (report.mutation.accepted) console.log('  gh accepted one `run rerun --failed` for the same attempt.');
    else if (report.mutation.invoked) console.log(`  gh rejected the rerun${report.mutation.detail ? `: ${report.mutation.detail}` : '.'}`);
    if (report.truncated) console.log('  Some evidence was truncated.');
    if (report.outcome === 'planned') console.log('  Plan only; pass --apply to submit one failed-jobs rerun.');
  }
  return ['planned', 'submitted', 'no-op'].includes(report.outcome) ? 0 : 1;
}
