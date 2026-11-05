import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { VerseMutationLockedError } from '../verse-queries.js';

/** Wire contract of the chief-of-staff desktop routes; mirrored here on purpose, never imported from src/core. */
export const COS_ASK_PATH = '/api/verse/fleet/cos/ask';
export const COS_STATUS_PATH = '/api/verse/fleet/cos/status';
export const COS_APPROVE_PATH = '/api/verse/fleet/cos/approve';

export type CosDelivery = null | 'sending' | 'sent' | 'uncertain';

export interface CosAsk { v: 1; id: string; ack: string; status: 'queued'; duplicate: boolean }
export interface CosStatus {
  v: 1; id: string; jobStatus: string; channel: string;
  draft: null | { text: string; digest: string };
  delivery: CosDelivery; needsYou: boolean;
}
export interface CosApproved { v: 1; id: string; delivery: 'sent' }

const isId = (value: unknown): value is string => typeof value === 'string' && /^cos-[0-9a-f]{32}$/.test(value);

export async function askCosTask(text: string): Promise<CosAsk> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<Partial<CosAsk> | null>(COS_ASK_PATH, { text }, token);
  if (!result || !isId(result.id) || typeof result.ack !== 'string') throw new Error('The task could not be confirmed. Check the Inbox pane.');
  touchMutationHold();
  return { v: 1, id: result.id, ack: result.ack, status: 'queued', duplicate: result.duplicate === true };
}

export async function readCosTask(id: string, signal?: AbortSignal): Promise<CosStatus> {
  const value = await apiGet<Partial<CosStatus> | null>(`${COS_STATUS_PATH}?id=${encodeURIComponent(id)}`, signal);
  const draft = value?.draft;
  if (!value || typeof value.jobStatus !== 'string' || typeof value.channel !== 'string'
    || (draft != null && (typeof draft.text !== 'string' || typeof draft.digest !== 'string'))) {
    throw new Error('The task status is unavailable.');
  }
  const delivery = value.delivery === 'sending' || value.delivery === 'sent' || value.delivery === 'uncertain' ? value.delivery : null;
  return { v: 1, id, jobStatus: value.jobStatus, channel: value.channel, draft: draft ?? null, delivery, needsYou: value.needsYou === true };
}

/** Sends the digest exactly as read; the draft text never goes back to the server. */
export async function approveCosTask(id: string, digest: string): Promise<CosApproved> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<CosApproved>(COS_APPROVE_PATH, { id, digest }, token);
  touchMutationHold();
  return result;
}

/** One short line for the card; delivery wins over the job status once the draft has moved. */
export function cosTaskLine(status: Pick<CosStatus, 'jobStatus' | 'draft' | 'delivery'> | null): string {
  if (!status) return 'Checking the task…';
  if (status.delivery === 'sent') return 'Sent';
  if (status.delivery === 'uncertain') return 'Delivery uncertain; check the channel before any retry';
  if (status.delivery === 'sending') return 'Sending the approved reply…';
  if (status.draft) return 'Drafted · waiting for your approval';
  switch (status.jobStatus) {
    case 'queued': return 'Queued · waiting for a worker';
    case 'claimed': case 'running': return 'A worker is on it';
    default: return 'Status unknown';
  }
}

/** The route is not in this build: a 404 without a code (or the dispatch gate), or a 503. */
export function isCosRouteAbsent(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 503 || (error.status === 404 && error.code === null));
}
