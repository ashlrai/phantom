/**
 * Who is talking to whom, about what, right now: agent-to-agent messages
 * grouped into threads by reply chain. `phm agents conversations`,
 * GET /api/verse/fleet/control/agent-conversations and the Map pane's thread
 * lines and Conversations panel all read this one projection.
 *
 * Not a second bus: it reads the durable bus inbox through the same scrubbed
 * projection as `phm messages` (agent-messages.ts), so every subject has
 * already passed the shared secret scrub. A sender or receiver no label proves
 * is kept and read "unknown agent"; a reply to a message that is not on the
 * bus starts its own thread. Names are routing labels, not proven identities.
 */
import { JOB_THREAD_PREFIX, agentName, projectAgentMessages } from './agent-messages.js';
import { busBodyJobId } from '../agents/bus-unified.js';
import { agentIdentityKeys, agentLabels, readAgentRegistry, resolveAgent,
  type AgentIdentity, type AgentIdentityKeyFor, type AgentRegistry } from '../agents/bus-identity.js';
import { scanBusInbox, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
import { agentToAgent } from './fleet-edges.js';
import { mapEdgeAgent } from './map-edges.js';
import { filterConversations, groupConversations, plainAge, UNKNOWN_AGENT, type AgentConversations, type Conversation, type ConversationMessage, type ConversationQuery } from './agent-conversation-model.js';

export * from './agent-conversation-model.js';

/** The map's own placing: a known agent is one the map or the bus can place. */
const mapPlace = (name: string, lane: string | null) => { const at = mapEdgeAgent({ name, lane }); return { known: at.role !== 'unknown', node: at.node }; };
/** Pure: messages in, threads out, placed by the map's rules. */
export const buildConversations = (messages: readonly ConversationMessage[], now: number): Conversation[] => groupConversations(messages, now, mapPlace);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

/** Bus receipts → messages. Subjects come from the scrubbed `phm messages` projection; only ids and states are read from the body. */
export function conversationMessages(rows: readonly BusInboxReceipt[]): ConversationMessage[] {
  const raw = new Map(rows.map(row => [row.envelope.id, record(row.envelope.body)]));
  return projectAgentMessages(rows).map(m => {
    const body = raw.get(m.id) ?? null, status = (text(body?.status) ?? '').toLowerCase();
    const outcome = (text(body?.outcome) ?? '').toLowerCase();
    // The same job channels `phm messages --job` honors, carried to the thread
    // level: the canonical body citation (`jobId` on work bodies, `taskId` on
    // a worker-handoff), the message's reported job link, and the
    // `job:<id>` conversation bucket it sits in.
    const jobIds = new Set<string>();
    const cited = busBodyJobId(body);
    if (cited !== undefined) jobIds.add(cited);
    if (m.job !== null) jobIds.add(m.job);
    if (m.conversation.startsWith(JOB_THREAD_PREFIX) && m.conversation.length > JOB_THREAD_PREFIX.length)
      jobIds.add(m.conversation.slice(JOB_THREAD_PREFIX.length));
    return {
      id: m.id, from: m.from.name, to: m.to.name, kind: m.kind, subject: m.summary, at: Date.parse(m.ts),
      replyTo: text(body?.replyTo) ?? text(body?.inReplyTo),
      ...(jobIds.size === 0 ? {} : { jobIds: [...jobIds].sort() }),
      // The message projection's conversation key is the declared thread bucket —
      // a v2 `thread` label, `threadId`, `job:<id>` or origin — the same key
      // `phm agents messages` reports as `threadId`. Only the synthesized
      // per-pair fallback is no thread the agents named, so it stays
      // reply-chain rooted.
      thread: m.conversation.startsWith('pair:') ? null : m.conversation,
      state: ['blocked', 'failed'].includes(status) || outcome === 'failed' ? 'blocked'
        : ['done', 'complete', 'completed'].includes(status) || ['complete', 'completed'].includes(outcome) ? 'done' : null,
      lane: m.from.lane,
    };
  });
}

/**
 * The identity scope the conversation sections share, built once per read:
 * `isSelf` names the agent under any of its labels (with the literal-label
 * fallback when no identity resolves — matching never widens on unknown
 * state), `denotes` reports whether a routing name is the agent — its own
 * labels, a name resolving to its identity, or a `group:<channel>:<topic>`
 * address of a channel it belongs to — and `agentOf` resolves a projection
 * name to a registered handle or null. `work mine`'s threads/awaiting/blocked
 * sections and the `--waiting-on` filter both narrow the one conversations
 * projection through this scope, so every surface agrees on who a wait names.
 */
export interface ConversationScope {
  isSelf: (name: string) => boolean;
  denotes: (name: string) => boolean;
  agentOf: (name: string) => string | null;
}

export function conversationScope(agent: string, registry: AgentRegistry | undefined,
  identity: AgentIdentity | undefined): ConversationScope {
  const selfNames = new Set(identity === undefined ? [] : agentLabels(identity).map(agentName));
  const channelNames = new Set(registry === undefined || identity === undefined ? [] :
    registry.channels.filter(channel => channel.members.includes(identity.handle)).map(channel => channel.name));
  return {
    isSelf: (name) => identity === undefined
      ? name === agentName(agent)
      : selfNames.has(name) || (registry !== undefined && resolveAgent(registry, name)?.id === identity.id),
    denotes: (name) => {
      if (identity === undefined) return name === agentName(agent);
      if (selfNames.has(name)) return true;
      if (name.startsWith('group:')) {
        const rest = name.slice('group:'.length), sep = rest.indexOf(':');
        return sep > 0 && channelNames.has(rest.slice(0, sep));
      }
      return registry !== undefined && resolveAgent(registry, name)?.id === identity.id;
    },
    agentOf: (name) => registry === undefined ? null : resolveAgent(registry, name)?.handle ?? null,
  };
}

/**
 * The `--waiting-on` match over one waiting thread: `waiting.on` must denote
 * the queried agent and the waiting (latest) message must not be the agent's
 * own — the same rule `work mine threads` applies, so a fleet-wide read and
 * the per-agent digest never disagree about who owes a reply. An unreadable
 * or missing registry and an unresolvable ref reduce to the literal-label
 * scope, matching never widens on unknown state.
 */
function waitingOnScope(ref: string, options: BusInboxOptions): (on: string, from: string) => boolean {
  const read = readAgentRegistry({ root: options.root });
  const registry = read.status === 'ok' ? read.registry : undefined;
  const identity = registry === undefined ? undefined : resolveAgent(registry, ref);
  const scope = conversationScope(ref, registry, identity);
  return (on, from) => scope.denotes(on) && !scope.isSelf(from);
}

/** Pure: a bus scan in, the typed JSON out. `identityOf` lets `--agent` match
 * every label of one registered identity; absent or unresolved, labels stay strict. */
export function buildAgentConversations(scan: { source: AgentConversations['source']; rows: readonly BusInboxReceipt[]; skipped?: number },
  query: ConversationQuery, now: number, identityOf?: AgentIdentityKeyFor,
  waitingOnMatch?: (on: string, from: string) => boolean): AgentConversations {
  const head = { schema: 'agents.conversations.v1' as const, version: 1 as const, generatedAt: new Date(now).toISOString(), source: scan.source };
  const skipped = scan.skipped ?? 0;
  if (scan.source === 'unavailable') return { ...head, conversations: null, waiting: null, skipped };
  const rows = scan.rows.filter(row => agentToAgent(row.envelope) && row.receivedAt <= now);
  const all = buildConversations(conversationMessages(rows), now);
  return { ...head, conversations: filterConversations(all, query, identityOf, waitingOnMatch), waiting: all.filter(c => c.state === 'waiting').length, skipped };
}

/** The one read behind the CLI, the API and the map. */
export function readAgentConversations(query: ConversationQuery = {}, options: BusInboxOptions = {}): AgentConversations {
  const identityOf = query.agent === undefined ? undefined : agentIdentityKeys({ root: options.root });
  const waitingOnMatch = query.waitingOn === undefined ? undefined : waitingOnScope(query.waitingOn, options);
  return buildAgentConversations(scanBusInbox(options), query, (options.now ?? Date.now)(), identityOf, waitingOnMatch);
}

/** `phm agents conversations` for people: one line per thread. */
export function formatAgentConversationsText(result: AgentConversations): string {
  if (!result.conversations) return 'Agent conversations: unknown (the agent bus could not be read).';
  if (!result.conversations.length) return 'No agent conversations.';
  const line = (c: Conversation) => {
    const names = c.participants.map(p => p.label === UNKNOWN_AGENT ? `${UNKNOWN_AGENT} (${p.name})` : p.name).join(', ');
    const state = c.waiting ? `${c.stateText} from ${c.waiting.on} for ${plainAge(c.waiting.ms)}` : c.stateText;
    return `  ${state} · ${names} · "${c.subject}" · ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}`;
  };
  return [`${result.conversations.length} conversation${result.conversations.length === 1 ? '' : 's'}, ${result.waiting} waiting for a reply.`,
    ...result.conversations.map(line),
    ...(result.skipped > 0 ? [`Skipped ${result.skipped} damaged bus record${result.skipped === 1 ? '' : 's'}.`] : [])].join('\n');
}
