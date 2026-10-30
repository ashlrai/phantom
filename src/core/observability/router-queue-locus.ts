import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { runWithLocusSessionIfConfigured } from '../integrations/locus.js';
import { withLocusJobChildEnv } from '../integrations/locus-job-env.js';
import type { QueueGh } from './router-queue-github.js';

/** Deliberately stricter than the general optional Locus seam: polling never
 * falls back to the ambient gh account when a sealed session is unavailable. */
export async function withQueueGithub<T>(fn: (gh: QueueGh) => Promise<T>): Promise<T> {
  return runWithLocusSessionIfConfigured(async handle => {
    if (!handle) throw new Error('Queue GitHub polling requires a verified Locus session');
    return fn(args => new Promise(resolve => {
      // Revalidate at EVERY dispatch; never use a captured or ambient provider environment.
      const env = { ...withLocusJobChildEnv(), GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
      execFile('gh', args, { cwd: tmpdir(), env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
        (error, stdout) => resolve({ ok: error === null, stdout: error ? '' : stdout }));
    }));
  }, { onWarn: () => { /* Caller prints only the fixed, values-free refusal. */ } });
}
