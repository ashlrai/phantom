import { readFile, stat } from 'node:fs/promises';
import { CiResumeInputsError, planCiResumeInputs, type CiResumePlan } from '../core/fleet/ci-resume-inputs.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-resume-inputs --manifest <file> --prior <file> --base <sha> --head <sha> [--json]\n       ashlr fleet ci-resume-inputs --stdin [--json]';
const MAX_INPUT_BYTES = 1024 * 1024;
const ENVELOPE_FIELDS = new Set(['manifest', 'prior', 'base', 'head']);
const fail = (message: string): never => { throw new CiResumeInputsError(message); };

/** Read-only resume-from-failure planner; never posts statuses or mutates CI. */
export async function cmdFleetCiResumeInputs(args: string[], deps: { git?: GitRunner; cwd?: string; getInput?: () => AsyncIterable<Uint8Array> } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const values = new Map<string, string>();
  let json = false;
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--stdin' && !stdin) { stdin = true; continue; }
    if (!['--manifest', '--prior', '--base', '--head'].includes(arg) || values.has(arg)
      || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write(`${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const manifestFile = values.get('--manifest'); const priorFile = values.get('--prior');
  const base = values.get('--base'); const head = values.get('--head');

  // Validate: --stdin and file args are mutually exclusive
  if (stdin) {
    if (manifestFile || priorFile || base || head) {
      process.stderr.write('ci-resume-inputs: --stdin may not be mixed with --manifest, --prior, --base or --head\n');
      return 2;
    }
    return runStdin(json, deps);
  }
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

async function runStdin(json: boolean, deps: { git?: GitRunner; cwd?: string; getInput?: () => AsyncIterable<Uint8Array> }): Promise<number> {
  const stream = deps.getInput ?? (() => process.stdin.iterator({ destroyOnReturn: false }));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream()) {
    total += chunk.byteLength;
    if (total > MAX_INPUT_BYTES) {
      process.stderr.write('ci-resume-inputs: input exceeds 1 MiB limit\n');
      return 2;
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    process.stderr.write('ci-resume-inputs: stdin is empty\n');
    return 2;
  }
  const raw = Buffer.concat(chunks, total).toString('utf8');
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch {
    process.stderr.write('ci-resume-inputs: stdin is not valid JSON\n');
    return 2;
  }
  const e = record(envelope);
  if (e === null) { process.stderr.write('ci-resume-inputs: stdin must be a JSON object\n'); return 2; }
  // Reject unknown fields to avoid silently selecting a wrong revision
  for (const key of Object.keys(e)) {
    if (!ENVELOPE_FIELDS.has(key)) {
      process.stderr.write(`ci-resume-inputs: unknown envelope field: ${key}\n`);
      return 2;
    }
  }
  const m = e['manifest']; const p = e['prior']; const b = field(e['base']); const h = field(e['head']);
  if (m === undefined || p === undefined || b === null || h === null) {
    process.stderr.write('ci-resume-inputs: envelope requires manifest, prior, base and head\n');
    return 2;
  }
  // Reject duplicates inside the envelope (manifest/prior appear twice, base/head appear twice)
  const envKeys = Object.keys(e);
  const seen = new Map<string, number>();
  for (let i = 0; i < envKeys.length; i++) {
    const k = envKeys[i]!;
    const prev = seen.get(k);
    if (prev !== undefined && (k === 'base' || k === 'head')) {
      process.stderr.write(`ci-resume-inputs: duplicate field: ${k}\n`);
      return 2;
    }
    seen.set(k, i);
  }
  try {
    const plan = await planCiResumeInputs({
      manifest: m, prior: p, base: b, head: h, cwd: deps.cwd ?? process.cwd(), git: deps.git,
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

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const field = (v: unknown): string | null =>
  // eslint-disable-next-line no-control-regex
  typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v) ? v : null;
