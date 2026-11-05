import { open } from 'node:fs/promises';
import { CiResumeInputsError, parseCiResumeManifest, planCiResumeInputs } from '../core/fleet/ci-resume-inputs.js';
import { fetchCiResumeReceipts } from '../core/fleet/ci-resume-receipts.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-resume-plan --repo owner/name --run ID --attempt N --artifact-id ID --manifest file.json --base HEX --head HEX [--archive file.zip] [--json]';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REV = /^[0-9a-f]{4,64}$/i;
const MAX_BYTES = 1024 * 1024;
const id = (v: string | undefined): number | null =>
  v && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;

/** Fetch bound evidence and produce an advisory plan; never acts on CI. */
export async function cmdFleetCiResumePlan(args: string[], deps: { gh?: GitRunner; git?: GitRunner; cwd?: string } = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(`${USAGE}\nAdvisory only; this does not authorize CI reuse.`); return 0; }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--run', '--attempt', '--artifact-id', '--manifest', '--base', '--head', '--archive'].includes(arg)
      || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('-')) {
      process.stderr.write(`${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? ''; const run = id(values.get('--run')); const attempt = id(values.get('--attempt'));
  const artifactId = id(values.get('--artifact-id')); const manifestFile = values.get('--manifest');
  const base = values.get('--base') ?? ''; const head = values.get('--head') ?? ''; const archive = values.get('--archive');
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..') || run === null || attempt === null || artifactId === null
    || !manifestFile || !REV.test(base) || !REV.test(head)) {
    process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
  }
  try {
    // Read at most one byte beyond the limit even if the file grows during the read.
    const file = await open(manifestFile, 'r').catch(() => { throw new CiResumeInputsError('manifest file cannot be read'); });
    let raw: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new CiResumeInputsError('manifest file must be a regular file of at most 1 MiB');
      const buf = Buffer.alloc(MAX_BYTES + 1); let used = 0;
      while (used < buf.length) {
        const { bytesRead } = await file.read(buf, used, buf.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > MAX_BYTES) throw new CiResumeInputsError('manifest file exceeds 1 MiB');
      raw = buf.subarray(0, used);
    } finally { await file.close(); }
    let value: unknown;
    try { value = JSON.parse(raw.toString('utf8')); } catch { throw new CiResumeInputsError('manifest file cannot be read as JSON'); }
    const manifest = parseCiResumeManifest(value);
    if (manifest.repo.toLowerCase() !== repo.toLowerCase()) throw new CiResumeInputsError('manifest repo does not match the requested repository');
    const { prior, diagnostics } = await fetchCiResumeReceipts({ repo, run, attempt, artifactId, ...(archive !== undefined ? { archive } : {}), gh: deps.gh });
    if (prior.repo.toLowerCase() !== manifest.repo.toLowerCase()) throw new CiResumeInputsError('receipts repo does not match manifest');
    const plan = await planCiResumeInputs({ manifest: value, prior, base, head, cwd: deps.cwd ?? process.cwd(), git: deps.git });
    for (const line of diagnostics) process.stderr.write(`ci-resume-plan: ${line}\n`);
    if (json) console.log(JSON.stringify(plan));
    else {
      console.log(`Advisory plan for ${plan.repo}: ${plan.summary.reuse} reusable, ${plan.summary.rerun} to rerun`);
      for (const job of plan.jobs) console.log(`  ${job.job}: ${job.decision} - ${job.reasons.join(', ')}${job.changedCoveredPaths.length ? ` (${job.changedCoveredPaths.join(', ')})` : ''}`);
      for (const path of plan.unmappedChangedPaths) console.log(`  unmapped change: ${path}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof CiResumeInputsError) { process.stderr.write(`ci-resume-plan: ${error.message}\n`); return 1; }
    throw error;
  }
}
