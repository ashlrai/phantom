import { readCiEvidence } from '../core/fleet/ci-evidence.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-evidence --repo <owner/repo> --run <id> [--attempt <n>] --job <id> [--json]';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export async function cmdFleetCiEvidence(args: string[], deps: { gh?: GitRunner } = {}): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--run', '--job', '--attempt'].includes(arg) || values.has(arg) || !args[i + 1]) {
      process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? '';
  const id = (value: string | undefined): number | null => {
    if (!value || !/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const run = id(values.get('--run'));
  const job = id(values.get('--job'));
  const attempt = values.has('--attempt') ? id(values.get('--attempt')) : undefined;
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--') || repo.endsWith('/.') || repo.endsWith('/..') || run === null || job === null || attempt === null) {
    process.stderr.write(`Invalid repository or ID. ${USAGE}\n`); return 2;
  }
  const evidence = await readCiEvidence(repo, run, job, deps.gh, attempt);
  if (json) console.log(JSON.stringify(evidence));
  else {
    console.log(`CI evidence ${evidence.repo} run ${run} job ${job}: ${evidence.source.status}`);
    if (evidence.attempt) console.log(`  Attempt requested: ${evidence.attempt.requested}; observed: ${evidence.attempt.observed ?? 'unknown'}`);
    if (evidence.jobName !== null) console.log(`  ${evidence.jobName} (${evidence.conclusion}); head ${evidence.headSha}`);
    if (evidence.failedSteps.length) console.log(`  Failed steps: ${evidence.failedSteps.join(', ')}`);
    for (const line of evidence.excerpts) console.log(`  ${line}`);
    if (evidence.source.truncated || evidence.source.outputTruncated) console.log('  Evidence was truncated.');
    if (evidence.source.status === 'ok' && !evidence.excerpts.length) console.log('  No matching error excerpts in the available log.');
  }
  return evidence.source.status === 'ok' ? 0 : 1;
}
