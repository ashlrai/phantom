import { parseCiResumeManifest, planCiResumeInputs } from './ci-resume-inputs.js';
import type { GitRunner } from '../verse/git-ops.js';

/** Seeds must be paired with actual CI results before they can become receipts. */
export async function ciInputDigests(opts: { manifest: unknown; head: string; cwd: string; git?: GitRunner }) {
  const manifest = parseCiResumeManifest(opts.manifest);
  const plan = await planCiResumeInputs({
    manifest: opts.manifest, prior: { version: 1, repo: manifest.repo, receipts: [] },
    base: opts.head, head: opts.head, cwd: opts.cwd, git: opts.git,
  });
  return { version: 1 as const, kind: 'ci-input-digest-seeds' as const, repo: plan.repo, head: plan.head,
    jobs: plan.jobs.map((job) => ({ id: job.job, inputDigest: job.headDigest })) };
}
