/**
 * The `worker-handoff` bus body contract: the exact shape
 * `ashlr fleet handoff-send --apply` and `agents bus handoff` emit, and the
 * only shape `fleet handoff-receive`/`handoff-reply` accept — exactly the
 * `kind`/`taskId`/`prompt` keys, `kind:'worker-handoff'`, a fleet job id and
 * a non-empty prompt. One definition serves the receive/reply verbs and the
 * read-side projections that list pending assignments, so they can never
 * disagree about what is receivable.
 */
import { findAgentChannel, resolveAgent, type AgentIdentity, type AgentRegistry } from '../agents/bus-identity.js';
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
 * The identity context the answered check resolves routing labels through —
 * the same registry semantics the receive verbs (`handoffRecipientMatches`)
 * and the pending-work matchers apply. `sameAgent` reports whether two labels
 * denote one registered identity (literal equality always holds); `channelMember`
 * reports whether a label denotes a member of the named registry channel, the
 * audience a `group:<channel>:<topic>` handoff address names.
 */
export interface HandoffAnswerScope {
  sameAgent(a: string, b: string): boolean;
  channelMember(label: string, channel: string): boolean;
}

/**
 * Bind one already-read registry into the answered check's label resolution:
 * a label denotes its identity through handle, `agent:` address, stable id or
 * alias (exact match first, then lowercase — the same fallback
 * `identityKeysFor`/`labelIdentityOf` apply), memoized across the scan. An
 * undefined registry — unreadable or absent — returns undefined so callers
 * keep literal-label matching: unknown identity state never widens which
 * replies count as the assignee's answer.
 */
export function handoffAnswerScope(registry: AgentRegistry | undefined): HandoffAnswerScope | undefined {
  if (registry === undefined) return undefined;
  const identities = new Map<string, AgentIdentity | undefined>();
  const identityOf = (label: string): AgentIdentity | undefined => {
    if (!identities.has(label)) {
      identities.set(label, resolveAgent(registry, label) ?? resolveAgent(registry, label.toLowerCase()));
    }
    return identities.get(label);
  };
  return {
    sameAgent: (a, b) => {
      if (a === b) return true;
      const left = identityOf(a), right = identityOf(b);
      return left !== undefined && right !== undefined && left.id === right.id;
    },
    channelMember: (label, channel) => {
      const identity = identityOf(label);
      return identity !== undefined && (findAgentChannel(registry, channel)?.members.includes(identity.handle) ?? false);
    },
  };
}

/** The registry channel a `group:<name>:<topic>` address names, or null for any other label. */
function groupChannel(address: string): string | null {
  if (!address.startsWith('group:')) return null;
  const rest = address.slice('group:'.length);
  const cut = rest.indexOf(':');
  return cut > 0 && cut < rest.length - 1 ? rest.slice(0, cut) : null;
}

/** The reply's destination must be the assigner — the literal `from` label or any label of its identity. */
function routedToAssigner(replyTo: string, assigner: string, scope?: HandoffAnswerScope): boolean {
  return replyTo === assigner || scope?.sameAgent(replyTo, assigner) === true;
}

/**
 * The reply's sender must be the addressee — the literal `to` label, another
 * label of its identity, or, for a `group:<channel>:<topic>` address, a member
 * of that channel: the room is the assignee set, the same membership rule the
 * pending-work matchers apply to channel mail.
 */
function sentByAddressee(replyFrom: string, addressee: string, scope?: HandoffAnswerScope): boolean {
  if (replyFrom === addressee) return true;
  if (scope === undefined) return false;
  if (scope.sameAgent(replyFrom, addressee)) return true;
  const channel = groupChannel(addressee);
  return channel !== null && scope.channelMember(replyFrom, channel);
}

/**
 * Whether a live `worker-handoff` envelope has been answered: a live reply
 * routed recipient -> sender — the exact direction the handoff verbs publish —
 * cites the handoff id through `inReplyTo`/`replyTo`. This is the same durable
 * evidence the conversation projection credits when it marks the handoff's
 * thread answered, so the pending-work surfaces and the thread view agree; a
 * citation routed any other way is not the assignee's answer. `cites` is every
 * citation the same bounded scan collected, live envelopes only.
 *
 * "Recipient -> sender" resolves through `scope` when the caller binds the
 * identity registry, so a reply sent under another label of either identity —
 * or by a member of the addressed channel — still counts; without a scope
 * only literal label equality does, so an unreadable registry narrows the
 * check rather than widening it.
 */
export function workerHandoffAnswered(
  handoff: { id: string; from: string; to: string },
  cites: readonly BusReplyCitation[],
  scope?: HandoffAnswerScope,
): boolean {
  return cites.some(c => c.citedId === handoff.id &&
    routedToAssigner(c.to, handoff.from, scope) &&
    sentByAddressee(c.from, handoff.to, scope));
}
