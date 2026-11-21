/** Read-only projection of retained bus receipts; routing labels grant no authority. */
import { validateBusEnvelope } from '../fleet/bus-envelope.js';
import {
  participantSchema, providerSchema, workFeedSchema, workPostBodySchema, workStatusBodySchema,
  type Participant, type WorkJob,
} from './bus-v2-schema.js';

/** The retained envelopes a job's state cites: its announcement and newest status. */
export interface WorkFeedCitation {
  /** Wire id of the `work.post` receipt that announced the job. */
  post: string;
  /** Wire id of the newest accepted `work.status` receipt; null while no status has moved the job. */
  status: string | null;
}

/** The retained receipt a feed refusal is attributable to. */
export interface WorkFeedRefusalReceipt {
  /** Wire id of the retained envelope; `agents bus show <id>` resolves it. */
  id: string;
  /** Receipt time in ms; the receipt itself stops mattering at `receivedAt + ttl`. */
  receivedAt: number;
  /** The envelope's own TTL in ms. */
  ttl: number;
}

export type WorkFeedResult =
  | { status: 'ok'; feed: { v: 2; jobs: WorkJob[] }; citations: ReadonlyMap<string, WorkFeedCitation> }
  | { status: 'refused'; reason: 'invalid-receipts' | 'invalid-participants' | 'invalid-body'
    | 'missing-provider' | 'duplicate-job' | 'owner-mismatch';
    /** The retained envelope whose processing refused the projection; absent
     * when no single well-formed receipt is the cause (receipt-shape,
     * participant-metadata or volume refusals). */
    receipt?: WorkFeedRefusalReceipt };

/** Resolves a sender label to a provider when the post and participants do not name one. */
export type WorkFeedProviderFor = (from: string) => Participant['provider'] | undefined;

/** Resolves a sender label to a canonical owner key when the registry knows it. */
export type WorkFeedOwnerKeyFor = (from: string) => string | undefined;

/**
 * Project one retained snapshot in cursor order (at most 1024 receipts).
 * This is not a historical ledger: orphan statuses are ignored. A provider must
 * come from the post, explicit participant metadata or the injected resolver —
 * never a guessed label. Statuses update jobs owned by the same sender label,
 * or by any label the injected `ownerKeyFor` resolver maps to the same key;
 * labels it cannot resolve still require exact label equality. No journal
 * writes, claims, dispatch, authentication or external calls occur.
 */
export function projectBusWorkFeed(receipts: readonly unknown[], participants: readonly Participant[] = [],
  providerFor?: WorkFeedProviderFor, ownerKeyFor?: WorkFeedOwnerKeyFor): WorkFeedResult {
  if (receipts.length > 1024) return { status: 'refused', reason: 'invalid-receipts' };
  const providers = new Map<string, Participant['provider']>();
  for (const input of participants) {
    const participant = participantSchema.safeParse(input);
    if (!participant.success || providers.has(participant.data.participantId)) {
      return { status: 'refused', reason: 'invalid-participants' };
    }
    providers.set(participant.data.participantId, participant.data.provider);
  }
  const ownerKeys = new Map<string, string | undefined>();
  const ownerKey = ownerKeyFor === undefined ? undefined : (label: string): string | undefined => {
    if (!ownerKeys.has(label)) {
      const key = ownerKeyFor(label);
      ownerKeys.set(label, typeof key === 'string' && key.length > 0 ? key : undefined);
    }
    return ownerKeys.get(label);
  };
  const jobs = new Map<string, WorkJob>();
  const citations = new Map<string, WorkFeedCitation>();
  let cursor = 0;
  for (const input of receipts) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { status: 'refused', reason: 'invalid-receipts' };
    }
    const row = input as Record<string, unknown>;
    if (typeof row.cursor !== 'number' || !Number.isSafeInteger(row.cursor) || row.cursor <= cursor ||
        typeof row.receivedAt !== 'number' || !Number.isSafeInteger(row.receivedAt) || row.receivedAt < 0) {
      return { status: 'refused', reason: 'invalid-receipts' };
    }
    const checked = validateBusEnvelope(row.envelope);
    if (!checked.ok) return { status: 'refused', reason: 'invalid-receipts' };
    cursor = row.cursor;
    const { body, from, to } = checked.value;
    // Legacy and unrelated bodies remain opaque, including authenticated peer messages.
    if (body === null || typeof body !== 'object' || Array.isArray(body)) continue;
    // A body-level refusal names the retained receipt that caused it, so a
    // poisoned feed is diagnosable instead of silently hiding every job.
    const refusal = { id: checked.value.id, receivedAt: row.receivedAt, ttl: checked.value.ttl };
    if (body.kind === 'work.post') {
      const post = workPostBodySchema.safeParse(body);
      if (!post.success) return { status: 'refused', reason: 'invalid-body', receipt: refusal };
      if (jobs.has(post.data.jobId)) return { status: 'refused', reason: 'duplicate-job', receipt: refusal };
      const hinted = providerFor?.(from);
      const resolved = hinted === undefined ? undefined
        : providerSchema.safeParse(hinted).success ? hinted : undefined;
      const provider = post.data.provider ?? providers.get(from) ?? resolved;
      if (!provider) return { status: 'refused', reason: 'missing-provider', receipt: refusal };
      jobs.set(post.data.jobId, { id: post.data.jobId, owner: from, to, provider,
        repo: post.data.repo, title: post.data.title,
        ...(post.data.dispatch === undefined ? {} : { dispatch: post.data.dispatch }),
        claimKeys: post.data.claimKeys, status: 'queued', updatedAt: row.receivedAt });
      citations.set(post.data.jobId, { post: checked.value.id, status: null });
    } else if (body.kind === 'work.status') {
      const status = workStatusBodySchema.safeParse(body);
      if (!status.success) return { status: 'refused', reason: 'invalid-body', receipt: refusal };
      const job = jobs.get(status.data.jobId);
      if (!job) continue;
      if (job.owner !== from) {
        const postKey = ownerKey?.(job.owner);
        const fromKey = ownerKey?.(from);
        if (postKey === undefined || postKey !== fromKey) {
          return { status: 'refused', reason: 'owner-mismatch', receipt: refusal };
        }
      }
      // Cursor order wins even when receipt clocks move backwards. The job's
      // detail is the newest status's own detail: a status without one clears
      // it, so a stale reason never rides a newer state.
      const next: WorkJob = { ...job, status: status.data.status, updatedAt: row.receivedAt };
      if (status.data.detail === undefined) delete next.detail;
      else next.detail = status.data.detail;
      jobs.set(job.id, next);
      // Every job was announced by a post that recorded its citation above.
      citations.get(job.id)!.status = checked.value.id;
    }
  }
  return { status: 'ok', feed: workFeedSchema.parse({ v: 2, jobs: [...jobs.values()] }), citations };
}
