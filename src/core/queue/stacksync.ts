import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { QueueJob } from './schema.js';

/** Optional local capability sink. Never sends credentials or job content. */
export async function exportStacksyncCompletion(
  job: QueueJob,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.PHANTOM_STACKSYNC !== 'on' || !env.PHANTOM_STACKSYNC_FILE) return;
  const claim = job.claims.at(-1);
  if (!claim?.finishedAt) return;
  try {
    const row = {
      jobId: job.id,
      status: job.status,
      durationMs: Math.max(0, Date.parse(claim.finishedAt) - Date.parse(claim.claimedAt)),
      // DONE is the operator completion signal for a previously recorded PR.
      mergedPr: job.status === 'DONE' ? job.prUrl ?? null : null,
    };
    const file = await open(env.PHANTOM_STACKSYNC_FILE,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600);
    try {
      if (!(await file.stat()).isFile()) return;
      await file.writeFile(JSON.stringify(row) + '\n');
    } finally { await file.close(); }
  } catch {
    // Optional telemetry must never change job completion behavior.
  }
}
