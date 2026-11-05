/**
 * Bus notice for a chief-of-staff worker pass: one small message when a pass
 * drafts a reply or blocks a job, so the bus view shows it in the same pass.
 * Bodies carry only the job id and provider or block reason, never draft or
 * request text, sender or thread ids.
 */
import type { CosWorkResult } from './worker.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { appendBusInbox, type BusInboxOptions } from '../fleet/bus-inbox.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REASON_CHARS = 200;

/** Pure: the envelope for a result, or null when the outcome is not announced. */
export function cosBusNotice(result: CosWorkResult, _now: number): BusEnvelope | null {
  if (result.outcome === 'drafted') {
    return {
      id: `cos-drafted-${result.id}`, from: 'cos-worker', to: 'mason', priority: 'P1', ttl: TTL_MS,
      body: { kind: 'cos-drafted', id: result.id, provider: result.provider },
    };
  }
  if (result.outcome === 'blocked') {
    return {
      id: `cos-blocked-${result.id}`, from: 'cos-worker', to: 'mason', priority: 'P2', ttl: TTL_MS,
      body: { kind: 'cos-blocked', id: result.id, reason: result.reason.replace(/\s+/g, ' ').slice(0, MAX_REASON_CHARS) },
    };
  }
  return null;
}

/** Never throws; anything other than a fresh post that validates reports 'failed'. */
export function postCosBusNotice(
  result: CosWorkResult,
  options: BusInboxOptions & { now?: () => number } = {},
): 'posted' | 'duplicate' | 'skipped' | 'failed' {
  try {
    const envelope = cosBusNotice(result, (options.now ?? Date.now)());
    if (!envelope) return 'skipped';
    const checked = validateBusEnvelope(envelope);
    if (!checked.ok) return 'failed';
    const posted = appendBusInbox(checked.value, options);
    return posted.status === 'posted' || posted.status === 'duplicate' ? posted.status : 'failed';
  } catch {
    return 'failed';
  }
}
