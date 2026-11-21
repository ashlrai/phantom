/**
 * The `worker-handoff` bus body contract: the exact shape
 * `ashlr fleet handoff-send --apply` and `agents bus handoff` emit, and the
 * only shape `fleet handoff-receive`/`handoff-reply` accept — exactly the
 * `kind`/`taskId`/`prompt` keys, `kind:'worker-handoff'`, a fleet job id and
 * a non-empty prompt. One definition serves the receive/reply verbs and the
 * read-side projections that list pending assignments, so they can never
 * disagree about what is receivable.
 */
import { isFleetJobId } from './runs-job-detail.js';

export interface WorkerHandoffBody { taskId: string; prompt: string }

const HANDOFF_BODY_KEYS = new Set(['kind', 'taskId', 'prompt']);

/** Exact body schema emitted by `ashlr fleet handoff-send --apply`. */
export function isWorkerHandoffBody(body: unknown): body is WorkerHandoffBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return Object.keys(record).every(key => HANDOFF_BODY_KEYS.has(key)) &&
    record['kind'] === 'worker-handoff' &&
    typeof record['taskId'] === 'string' && isFleetJobId(record['taskId']) &&
    typeof record['prompt'] === 'string' && record['prompt'].trim().length > 0;
}

/** One live envelope's citation of a prior envelope it answers. */
export interface BusReplyCitation {
  /** The `inReplyTo`/`replyTo` value — the id of the envelope being answered. */
  readonly citedId: string;
  /** The citing envelope's own `from`/`to` routing labels. */
  readonly from: string;
  readonly to: string;
}

/**
 * The prior-envelope citations one bus body makes through `inReplyTo`/`replyTo`
 * — the fields the reply paths (`postBusReply`, the `worker-exit` reply
 * `fleet handoff-reply` publishes) stamp and the conversation projection
 * threads on. Non-object bodies and non-string or empty values cite nothing.
 */
export function busReplyCitations(envelope: { from: string; to: string; body: unknown }): BusReplyCitation[] {
  if (envelope.body === null || typeof envelope.body !== 'object' || Array.isArray(envelope.body)) return [];
  const record = envelope.body as Record<string, unknown>;
  const out: BusReplyCitation[] = [];
  for (const key of ['inReplyTo', 'replyTo'] as const) {
    const cited = record[key];
    if (typeof cited === 'string' && cited !== '') out.push({ citedId: cited, from: envelope.from, to: envelope.to });
  }
  return out;
}

/**
 * Whether a live `worker-handoff` envelope has been answered: a live reply
 * routed recipient -> sender — the exact direction the handoff verbs publish —
 * cites the handoff id through `inReplyTo`/`replyTo`. This is the same durable
 * evidence the conversation projection credits when it marks the handoff's
 * thread answered, so the pending-work surfaces and the thread view agree; a
 * citation routed any other way is not the assignee's answer. `cites` is every
 * citation the same bounded scan collected, live envelopes only.
 */
export function workerHandoffAnswered(
  handoff: { id: string; from: string; to: string },
  cites: readonly BusReplyCitation[],
): boolean {
  return cites.some(c => c.citedId === handoff.id && c.from === handoff.to && c.to === handoff.from);
}
