/** Read-only listing of chief-of-staff intake jobs for the desktop surface. */
import type { QueueStatus } from '../queue/schema.js';
import { scrubSecrets } from '../util/scrub.js';
import { cosQueueStore, cosStatus, isCosJobId, parseCosIntakeRoute, type CosDelivery } from './intake.js';

export interface CosTaskSummary {
  id: string;
  jobStatus: QueueStatus;
  /** Draft origin channel when a draft exists, else the intake channel. */
  channel: string;
  needsYou: boolean;
  delivery: CosDelivery | null;
  hasDraft: boolean;
  /** Scope collapsed to one line, scrubbed, at most 140 characters. */
  request: string;
}

/** Free operator text: control characters become spaces (one per run via the space fold), then scrub and bound. */
const requestText = (scope: string): string =>
  scrubSecrets([...scope].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char)
    .join('').replace(/ {2,}/g, ' ').trim()).slice(0, 140);

/** Newest first (the queue appends). Sender/thread ids and draft material stay server-side. */
export async function listCosTasks(runsDir: string, limit = 20): Promise<CosTaskSummary[]> {
  const cap = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.floor(limit))) : 20;
  const { jobs } = await cosQueueStore(runsDir).read();
  const tasks: CosTaskSummary[] = [];
  for (let i = jobs.length - 1; i >= 0 && tasks.length < cap; i--) {
    const job = jobs[i]!;
    if (!isCosJobId(job.id)) continue;
    const route = parseCosIntakeRoute(job.acceptance);
    if (!route) continue;
    const state = await cosStatus(job.id, runsDir);
    tasks.push({ id: job.id, jobStatus: job.status, channel: state.draft?.origin.channel ?? route.origin.channel,
      needsYou: state.needsYou, delivery: state.delivery ?? null, hasDraft: state.draft !== undefined,
      request: requestText(job.scope) });
  }
  return tasks;
}
