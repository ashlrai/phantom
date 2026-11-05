import { readFile, stat } from 'node:fs/promises';
import { CiResumeInputsError, planCiResumeInputs, type CiResumePlan } from '../core/fleet/ci-resume-inputs.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-resume-inputs --manifest <file> --prior <file> --base <sha> --head <sha> [--json]';
const MAX_INPUT_BYTES = 1024 * 1024;
const fail = (message: string): never => { throw new CiResumeInputsError(message); };

/** Read-only resume-from-failure planner; never posts statuses or mutates CI. */
export async function cmdFleetCiResumeInputs(args: string[], deps: { git?: GitRunner; cwd?: string } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--manifest', '--prior', '--base', '--head'].includes(arg) || values.has(arg)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write(`${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const manifestFile = values.get('--manifest'); const priorFile = values.get('--prior');
  const base = values.get('--base'); const head = values.get('--head');
  if (!manifestFile || !priorFile || !base || !head) { process.stderr.write(`${USAGE}\n`); return 2; }
  const readJson = async (file: string, label: string): Promise<unknown> => {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_INPUT_BYTES) fail(`${label} must be a regular file of at most 1 MiB`);
      return JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (error) {
      if (error instanceof CiResumeInputsError) throw error;
      fail(`${label} cannot be read as JSON`);
    }
  };
  try {
    const plan = await planCiResumeInputs({
      manifest: await readJson(manifestFile, 'manifest file'),
      prior: await readJson(priorFile, 'prior file'),
      base, head, cwd: deps.cwd ?? process.cwd(), git: deps.git,
    });
    if (json) console.log(JSON.stringify(plan, null, 2));
    else printText(plan);
    return 0;
  } catch (error) {
    if (error instanceof CiResumeInputsError) {
      process.stderr.write(`ci-resume-inputs: ${error.message}\n`); return 2;
    }
    throw error;
  }
}

function printText(plan: CiResumePlan): void {
  console.log(`ci-resume-inputs ${plan.repo} ${plan.base.slice(0, 12)}..${plan.head.slice(0, 12)}:`
    + ` ${plan.summary.reuse} reusable, ${plan.summary.rerun} to rerun`);
  for (const job of plan.jobs) {
    const via = job.prior ? ` (prior run ${job.prior.run}${job.prior.attempt ? ` attempt ${job.prior.attempt}` : ''} ${job.prior.conclusion})` : '';
    console.log(`  ${job.job}: ${job.decision} - ${job.reasons.join(', ')}${via}`);
    for (const p of job.changedCoveredPaths) console.log(`    covered change: ${p}`);
  }
  for (const p of plan.unmappedChangedPaths) console.log(`  unmapped change: ${p}`);
}
