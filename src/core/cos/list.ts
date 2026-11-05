/** Read-only listing of chief-of-staff intake jobs for the desktop surface. */
import { join } from 'node:path';
import { QueueStore } from '../queue/store.js';
import type { QueueStatus } from '../queue/schema.js';
import { scrubSecrets } from '../util/scrub.js';
import { cosStatus } from './intake.js';

export interface CosTaskSummary {
  id: string;
  jobStatus: QueueStatus;
  /** Draft origin channel when a draft exists, else the intake channel. */
  channel: string;
  needsYou: boolean;
  delivery: 'sending' | 'sent' | 'uncertain' | null;
  hasDraft: boolean;
  /** Scope collapsed to one line, scrubbed, at most 140 characters. */
  request: string;
}

const JOB_ID = /^cos-[a-f0-9]{32}$/;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const intakeChannel = (acceptance: string): string | null => {
  try {
    const route: unknown = JSON.parse(acceptance);
    return record(route) && route.kind === 'cos-intake' && record(route.origin) && typeof route.origin.channel === 'string'
      ? route.origin.channel : null;
  } catch { return null; }
};

/** Free operator text: control characters become spaces (one per run via the space fold), then scrub and bound. */
const requestText = (scope: string): string =>
  scrubSecrets([...scope].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char)
    .join('').replace(/ {2,}/g, ' ').trim()).slice(0, 140);

/** Newest first (the queue appends). Sender/thread ids and draft material stay server-side. */
export async function listCosTasks(runsDir: string, limit = 20): Promise<CosTaskSummary[]> {
  const cap = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.floor(limit))) : 20;
  const { jobs } = await new QueueStore(join(runsDir, 'queue'), 250).read();
  const tasks: CosTaskSummary[] = [];
  for (let i = jobs.length - 1; i >= 0 && tasks.length < cap; i--) {
    const job = jobs[i]!;
    if (!JOB_ID.test(job.id)) continue;
    const channel = intakeChannel(job.acceptance);
    if (channel === null) continue;
    const state = await cosStatus(job.id, runsDir);
    tasks.push({ id: job.id, jobStatus: job.status, channel: state.draft?.origin.channel ?? channel,
      needsYou: state.needsYou, delivery: state.delivery ?? null, hasDraft: state.draft !== undefined,
      request: requestText(job.scope) });
  }
  return tasks;
}
