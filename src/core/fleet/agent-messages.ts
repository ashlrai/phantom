/**
 * Agent-to-agent messages: one read-only projection of the durable bus inbox
 * (bus-inbox.ts), shared by `phm messages`, GET /api/verse/agent-bus/messages,
 * the desktop Messages pane and the Org pane's "talking now" lines. Not a second
 * bus: nothing here writes. Addresses are routing labels, not authenticated
 * identities, and every emitted string passes the shared secret scrub.
 */
import { scrubSecrets } from '../util/scrub.js';
import { busBodyKind, busBodyResultOutcome, busBodyThread, PROVIDERS, WORK_RESULT_OUTCOMES,
  type WorkResultOutcome } from '../agents/bus-v2-schema.js';
import { busBodyInReplyToMatch, busBodyJobId, busBodySummary, busInboxJobMarker, jobAnnotationFromFeed, labelIdentityOf,
  type BusEnvelopeLookupJob } from '../agents/bus-unified.js';
import { readBusWorkFeed, type BusWorkFeedReadResult } from '../agents/bus-work-feed-read.js';
import { agentChannelNameSchema, agentRefAddressMatcher, readAgentRegistry, resolveAgent, BUS_CLIS, type AgentIdentityKeyFor } from '../agents/bus-identity.js';
import { BUS_PRIORITIES, type BusPriority } from './bus-envelope.js';
import { scanBusInbox, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';

export const AGENT_MESSAGE_KINDS = ['ask', 'reply', 'handoff', 'status', 'blocker'] as const;
export type AgentMessageKind = typeof AGENT_MESSAGE_KINDS[number];
export const AGENT_MESSAGES_MAX_LIMIT = 1024;
export const AGENT_MESSAGES_DEFAULT_LIMIT = 50;
/** Longest `--contains` needle accepted; the summary it matches is already clipped far shorter. */
export const AGENT_MESSAGES_CONTAINS_MAX = 512;
/** Conversation key prefix for messages about one job (`job:<jobId>`). */
export const JOB_THREAD_PREFIX = 'job:';
/** A job id or thread label is the same printable label every bus read accepts. */
const JOB_ID = /^[\x21-\x7e]{1,128}$/;
const SUMMARY_MAX = 160;

export interface AgentRef { name: string; lane: string | null }
/** Key order is the JSON contract: keep it stable. */
export interface AgentMessage {
  id: string; ts: string; priority: BusPriority; from: AgentRef; to: AgentRef; kind: AgentMessageKind;
  summary: string; conversation: string; job: string | null; pr: string | null;
  /**
   * Present only when the body names a job — a `jobId` citation
   * (`work.post`, `work.status`, `work.result` or `wake`) or a
   * `worker-handoff`'s `taskId`: the same live
   * `BusEnvelopeLookupJob` `agents bus inbox`, `agents bus show` and
   * `agents bus work mine` resolve — the job's feed status and claim
   * coverage, the feed's own refusal, or its unreadable state. Absent on
   * every other body kind; `job` stays the display link and may name a
   * different id than the citation.
   */
  jobState?: BusEnvelopeLookupJob;
}
export interface AgentMessages {
  schema: 'agent-messages.v1';
  source: 'available' | 'missing' | 'unavailable';
  messages: AgentMessage[];
  /** Live messages that matched the filter before --limit. */
  matched: number;
  /** Damaged bus rows skipped while reading. */
  skipped: number;
}
/** `with` narrows `agent` to the two-way talk between that agent and one other; `kind` keeps one classified kind; `priority` keeps one envelope band; `job` keeps the traffic that names one job; `thread` keeps only note/context bodies carrying that v2 thread label — a row-level filter `readAgentMessages` applies before projection, the same `busBodyThread` match every other bus read's `--thread` applies; `contains` keeps only messages whose scrubbed one-line summary carries the needle as a case-insensitive substring — the fleet-wide text search no other bus read offers; `from` keeps only the messages one sender wrote — the same sender-inclusion match `comms bus read|watch --from`, `agents bus inbox --from`, `agents bus channel read --from`, `agents bus wakes --from`, `fleet bus-follow --from` and `fleet_agent_inbox`'s `from` apply, deciding on each row's `from` only so rows merely addressed to that agent never pass; `excludeFrom` drops mail sent under every registered spelling of one identity — the same sender-exclusion rule `comms bus read|watch --exclude-from`, `fleet bus-follow --exclude-from`, `fleet_bus_inbox`'s `excludeFrom` and `agents bus inbox`/`channel read`'s `excludeFrom` apply, deciding on each row's `from` only, so a flooding sender never reaches the page while every other sender's traffic still does; `inReplyTo` keeps only envelopes whose object body cites that envelope id through its own `inReplyTo` field — a row-level filter applied before projection on the raw body, the shared `busBodyInReplyToMatch` own-property exact-match rule `comms bus read|watch --in-reply-to`, `fleet bus-follow --in-reply-to`, `fleet_bus_inbox`'s `inReplyTo`, `agents bus inbox --in-reply-to` and `agents bus channel read --in-reply-to` apply, never the `replyTo` alias or a substring, so "who answered envelope X" is one filtered read of the whole fleet timeline — replies addressed to anyone, not only the reader's own inbox; `channel` keeps only the envelopes addressed to `group:<channel>:*` — the room's whole traffic under every topic, the same address prefix `agents bus inbox --channel` and `channel read` match — a row-level filter `readAgentMessages` applies before projection on the raw `to` label, so mail to agents and other rooms never reaches the page while every post in the named room still does; the value is the strict channel-name grammar, never a guessed match; `to` keeps only the envelopes addressed to that routing label — a handle, `agent:` address, stable id or alias of one registered identity matches every label of that identity, an unresolvable ref keeps exact-label matching — the same addressed-to rule `comms bus read|watch --to` and `fleet_bus_inbox`'s `to` apply through `agentRefAddressMatcher`, decided on each row's raw `to` label so "everything addressed to leaders" or "everything addressed to agent X" is one filtered read of the whole fleet timeline; `before` keeps only messages received strictly before its cutoff — the exclusive upper bound every bus read's `--before` applies, composing with `since` into one `[since, before)` window on the receipt time; `id` keeps only the envelope whose own wire id is strictly equal to the value — the same exact-envelope match `comms bus read|watch --id`, `fleet bus-follow --id`, `fleet_bus_inbox`'s `id`, `agents bus inbox --id` and `agents bus channel read --id` apply, never a substring — so "where did envelope X go" is one filtered read of the whole fleet timeline; `bodyKind` keeps only messages whose body carries that exact kind discriminator — the same `busBodyKind` own-field exact match `agents bus inbox --body-kind`, `agents bus channel read --body-kind`, `agents bus wakes --body-kind` and `agents conversations --body-kind` apply, decided on the raw body before projection so a body carrying no discriminator never matches — an unrecognized but printable value is an honest empty page, never an error and never a widened one; `result` keeps only the `work.result` receipts reporting that one outcome — the same `WORK_RESULT_OUTCOMES` codes the work feed's `--result` filter and the retained `work.result` citation match (`reserved`, `admitted`, `complete`, `failed`) — decided on the raw body's own `kind`/`outcome` fields before projection through `busBodyResultOutcome`, so every other body kind (a `work.release` body's own `released`/`completed` outcome included) and a `work.result` carrying no outcome never matches — the envelope-level audit trail the feed's per-job newest-result `--result` cannot show, since a job that failed then recovered still lists its earlier `failed` receipt here. */
export interface AgentMessagesQuery { since?: number; before?: number; agent?: string; with?: string; kind?: AgentMessageKind; priority?: BusPriority; job?: string; thread?: string; contains?: string; from?: string; excludeFrom?: string; inReplyTo?: string; channel?: string; to?: string; id?: string; bodyKind?: string; result?: WorkResultOutcome; limit?: number }

type Body = Record<string, unknown>;
const record = (value: unknown): Body | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Body : null;
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
// eslint-disable-next-line no-control-regex -- strip control bytes from untrusted display text.
const oneLine = (text: string) => scrubSecrets(text).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (text: string) => text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;

const KNOWN_LANES: readonly string[] = [...new Set<string>([...PROVIDERS, ...BUS_CLIS, 'codex', 'codex-local', 'claude-api', 'devin-flash', 'gemini', 'zai', 'agy', 'leader'])]
  .sort((a, b) => b.length - a.length);
/** Strip routing prefixes so `agent:claude-7` reads as `claude-7`. */
export function agentName(address: string): string {
  return oneLine(address.replace(/^(agent|lane|pool):/, '')) || 'unknown';
}
/** A lane is reported only when the label proves it; otherwise null (unknown). */
export function laneOf(name: string, vendor: string | null): string | null {
  if (vendor && KNOWN_LANES.includes(vendor.toLowerCase())) return vendor.toLowerCase();
  const lower = name.toLowerCase();
  return KNOWN_LANES.find(lane => lower === lane || lower.startsWith(`${lane}-`) || lower.startsWith(`${lane}/`)) ?? null;
}

function bodyText(body: Body | null): string | null {
  if (!body) return null;
  const peer = record(body.peer), value = record(body.value);
  return str(body.text) ?? str(peer?.text) ?? str(value?.text) ?? str(body.prompt) ?? str(body.reason) ?? str(body.summary) ?? str(body.title);
}

/** v2 work bodies carry their payload in typed fields, not free text; compose
 * the one-line read from them. claim tokens, queueId and receiptId stay out. */
function workText(body: Body | null): string | null {
  if (!body) return null;
  const kind = str(body.kind);
  if (kind === 'work.status') {
    const status = str(body.status), detail = str(body.detail);
    return status === null ? detail : detail === null ? status : `${status}: ${detail}`;
  }
  if (kind === 'work.result') {
    const outcome = str(body.outcome), reason = str(body.reason);
    return outcome === null ? reason : reason === null ? outcome : `${outcome}: ${reason}`;
  }
  if (kind === 'work.claim' || kind === 'work.release') {
    const op = kind === 'work.release' ? 'release' : str(body.op);
    const key = str(body.claimKey), outcome = str(body.outcome);
    const head = [op, key].filter((part): part is string => part !== null).join(' ');
    if (head === '') return outcome;
    return outcome === null ? head : `${head}: ${outcome}`;
  }
  return null;
}

/** The job a body belongs to: its own `jobId`, else the newest `work.post` in
 * the scan listing its `claimKey` (work.claim renew and work.release carry no
 * jobId). Real fields only; no match means no job, never a guess. */
function jobIdOf(body: Body | null, jobByClaim: ReadonlyMap<string, string>): string | null {
  if (!body) return null;
  const direct = str(body.jobId);
  if (direct !== null) return direct;
  const key = str(body.claimKey);
  return key === null ? null : jobByClaim.get(key) ?? null;
}

/** Map the bus's open-ended body kinds onto five plain words. */
export function classify(envelope: BusInboxReceipt['envelope'], body: Body | null): AgentMessageKind {
  const kind = (str(body?.kind) ?? '').toLowerCase();
  // Whole tokens only, so `feedback` never reads as an `ack`.
  const tokens = new Set(kind.split(/[^a-z]+/).filter(Boolean));
  const has = (...words: string[]) => words.some(word => tokens.has(word));
  const peerKind = str(record(body?.peer)?.kind);
  const status = (str(body?.status) ?? '').toLowerCase();
  const outcome = (str(body?.outcome) ?? '').toLowerCase();
  if (envelope.channel === 'handoff' || has('handoff', 'assignment') || peerKind === 'handoff') return 'handoff';
  if (has('blocked', 'blocker', 'escalation', 'failed', 'incident') || ['blocked', 'failed'].includes(status) || outcome === 'failed') return 'blocker';
  // Slack ingress stamps the peer protocol's declared kind; a request asks and
  // a reply answers even when the body carries no local replyTo.
  if (kind === 'slack-coordination') {
    const messageType = (str(body?.messageType) ?? '').toLowerCase();
    if (messageType === 'request') return 'ask';
    if (messageType === 'reply') return 'reply';
  }
  if (has('reply', 'result', 'ack', 'exit') || str(body?.replyTo) || str(body?.inReplyTo)) return 'reply';
  if (['task', 'review', 'query'].includes(peerKind ?? '') || kind === 'work.post' || kind.endsWith('owner-message')
    || has('interjection', 'request', 'ask', 'question')) return 'ask';
  return (bodyText(body) ?? '').trim().endsWith('?') ? 'ask' : 'status';
}

const JOB = /\b((?:RQ|FIXUP|LAND|FIX)-[A-Z0-9][A-Z0-9-]{2,80})\b/;
const PR = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#|\/pull\/)([1-9][0-9]{0,8})\b|(?:^|[\s(])#([1-9][0-9]{0,8})\b/;
function related(body: Body | null, text: string, jobId: string | null): { job: string | null; pr: string | null } {
  const fields = body ? [body.rq, body.taskId, body.jobId, jobId, body.job,
    ...(Array.isArray(record(body.peer)?.refs) ? record(body.peer)!.refs as unknown[] : []),
    ...(Array.isArray(body.refs) ? body.refs : [])] : [jobId];
  const haystack = [...fields.filter((v): v is string => typeof v === 'string'), text].join(' ');
  const job = JOB.exec(haystack)?.[1] ?? null;
  const pr = PR.exec(haystack);
  return { job: job && oneLine(job), pr: pr ? oneLine(pr[1] ? `${pr[1]}#${pr[2]}` : `#${pr[3]}`) : null };
}

function threadKey(body: Body | null, jobId: string | null): string | null {
  return str(body?.thread) ?? str(body?.threadId) ?? str(record(body?.peer)?.threadId)
    ?? (jobId === null ? null : `${JOB_THREAD_PREFIX}${jobId}`) ?? str(body?.origin);
}

/**
 * Pure projection, oldest-to-newest input in, newest-first messages out.
 * `jobStateOf` resolves the live feed state behind a body's job citation
 * (`jobId` on `work.post`, `work.status`, `work.result` or `wake`, or
 * `taskId` on a `worker-handoff`);
 * without it — the map and conversations projections, which carry no feed
 * read — `jobState` stays absent rather than guessed.
 */
export function projectAgentMessages(rows: readonly BusInboxReceipt[],
  jobStateOf?: (jobId: string) => BusEnvelopeLookupJob): AgentMessage[] {
  const byId = new Map(rows.map(row => [row.envelope.id, row]));
  const conversations = new Map<string, string>();
  const vendors = new Map<string, string>();
  for (const { envelope } of rows) if (envelope.sender && envelope.sender.agent_id === envelope.from) vendors.set(envelope.from, envelope.sender.vendor);
  const sorted = [...rows].sort((a, b) => a.receivedAt - b.receivedAt || a.cursor - b.cursor);
  // work.claim renew and work.release carry a claimKey, not a jobId; the newest
  // work.post in the scan listing that key owns the thread.
  const jobByClaim = new Map<string, string>();
  for (const { envelope } of sorted) {
    const body = record(envelope.body);
    if (str(body?.kind) !== 'work.post') continue;
    const jobId = str(body?.jobId);
    if (jobId === null || !Array.isArray(body?.claimKeys)) continue;
    for (const key of body.claimKeys) {
      const claimKey = str(key);
      if (claimKey !== null) jobByClaim.set(claimKey, jobId);
    }
  }
  const conversationOf = (row: BusInboxReceipt, depth = 0): string => {
    const known = conversations.get(row.envelope.id);
    if (known) return known;
    const body = record(row.envelope.body);
    const parentId = str(body?.replyTo) ?? str(body?.inReplyTo);
    const parent = parentId ? byId.get(parentId) : undefined;
    const key = threadKey(body, jobIdOf(body, jobByClaim)) ?? (parent && parent !== row && depth < 50 ? conversationOf(parent, depth + 1)
      : `pair:${[agentName(row.envelope.from), agentName(row.envelope.to)].sort().join('|')}`);
    conversations.set(row.envelope.id, key);
    return key;
  };
  return sorted.map(row => {
    const { envelope } = row, body = record(envelope.body);
    const jobId = jobIdOf(body, jobByClaim);
    const feedJobId = jobStateOf === undefined ? undefined : busBodyJobId(envelope.body);
    const jobState = feedJobId === undefined || jobStateOf === undefined ? undefined : jobStateOf(feedJobId);
    // work.* operations keep their terse field formats; every other kind the
    // bus knows summarizes through the same one-line composer the inbox frame
    // uses, so `phm messages`, conversations and the map never show a bare
    // kind name where the frame would show the payload.
    const raw = workText(body) ?? busBodySummary(body) ?? bodyText(body) ?? str(body?.kind) ?? (typeof envelope.body === 'string' ? envelope.body : null);
    const summary = raw ? clip(oneLine(raw)) : '';
    const from = agentName(envelope.from), to = agentName(envelope.to);
    return {
      id: oneLine(envelope.id), ts: new Date(row.receivedAt).toISOString(), priority: envelope.priority,
      from: { name: from, lane: laneOf(from, vendors.get(envelope.from) ?? null) },
      to: { name: to, lane: laneOf(to, vendors.get(envelope.to) ?? null) },
      kind: classify(envelope, body), summary: summary || 'No text.', conversation: oneLine(conversationOf(row)),
      ...related(body, raw ?? '', jobId),
      ...(jobState === undefined ? {} : { jobState }),
    };
  }).reverse();
}

/**
 * `agent`/`with` match a routing label or lane exactly as before; when
 * `identityOf` resolves both sides to the same registered identity, the labels
 * count as one agent, so a handle, alias and `agent:` address never split a
 * filter. `from` keeps only the messages one sender wrote under the same
 * name/lane/identity-key match — the sender-inclusion counterpart of
 * `excludeFrom`, so "everything agent X sent" is one filtered read of the
 * whole fleet timeline while rows merely addressed to X stay out; it decides
 * on `from` only and composes with every other filter, a sender both included
 * and excluded matching nothing. `excludeFrom` drops a message whose sender
 * (`from`) matches the ref
 * by the same name/lane/identity-key rule — sender only, never the recipient —
 * the same sender-exclusion every other bus read applies, so a flooding
 * sender's traffic never reaches the page while every other sender's does; it
 * composes with `agent`/`with` — the excluded identity's own rows drop while
 * rows merely addressed to it stay. An unresolvable side changes nothing. `job` keeps a message that
 * names the job through any channel the row itself reports: its `job` link,
 * a live `jobState` citation (`jobId` on a feed-citing body or `taskId` on a
 * worker-handoff) or membership in the `job:<id>` conversation bucket —
 * replies into the thread and claim operations mapped through a declared
 * claim key count, exactly the rows `conversation` already groups. Every
 * match is a real projected field, never a text guess; a message naming no
 * job never passes. Query refs (`agent`/`with`/`excludeFrom`) resolve their
 * identity key through `refKeyFor` when the read supplies it — exact
 * `resolveAgent` semantics, so a case-variant or otherwise unregistered
 * spelling never inherits an identity's label set — while the projected
 * `from`/`to` labels keep folding through `identityOf`; a caller passing
 * only `identityOf` keeps the historical fold on both sides.
 */
export function filterAgentMessages(messages: readonly AgentMessage[], query: AgentMessagesQuery,
  identityOf?: AgentIdentityKeyFor, refKeyFor?: AgentIdentityKeyFor): AgentMessage[] {
  const want = (value: string | undefined) => value ? agentName(value).toLowerCase() : null;
  const agent = want(query.agent), peer = want(query.with), from = want(query.from), exclude = want(query.excludeFrom);
  const keyFor = refKeyFor ?? identityOf;
  const agentKey = query.agent ? keyFor?.(agentName(query.agent)) : undefined;
  const peerKey = query.with ? keyFor?.(agentName(query.with)) : undefined;
  const fromKey = query.from ? keyFor?.(agentName(query.from)) : undefined;
  const excludeKey = query.excludeFrom ? keyFor?.(agentName(query.excludeFrom)) : undefined;
  const is = (ref: AgentRef, name: string, key: string | undefined) =>
    ref.name.toLowerCase() === name || ref.lane === name || (key !== undefined && identityOf?.(ref.name) === key);
  const jobThread = query.job === undefined ? null : `${JOB_THREAD_PREFIX}${query.job}`;
  // --contains is a case-insensitive substring over the scrubbed one-line
  // summary — the text the read actually shows, so a match is always visible
  // in the row it selects. Whitespace collapses the same way the summary's
  // does, so a phrase typed with stray spacing still finds its line.
  const needle = query.contains === undefined ? undefined
    : query.contains.toLowerCase().replace(/\s+/g, ' ').trim();
  return messages.filter(m => (query.since === undefined || Date.parse(m.ts) >= query.since)
    && (query.before === undefined || Date.parse(m.ts) < query.before)
    && (query.kind === undefined || m.kind === query.kind)
    && (query.priority === undefined || m.priority === query.priority)
    && (query.job === undefined || m.job === query.job || m.jobState?.jobId === query.job || m.conversation === jobThread)
    && (needle === undefined || needle === '' || m.summary.toLowerCase().includes(needle))
    && (from === null || is(m.from, from, fromKey))
    && (exclude === null || !is(m.from, exclude, excludeKey))
    && (!agent || (peer ? (is(m.from, agent, agentKey) && is(m.to, peer, peerKey)) || (is(m.from, peer, peerKey) && is(m.to, agent, agentKey)) : is(m.from, agent, agentKey) || is(m.to, agent, agentKey))));
}

/**
 * The shared rows→messages pipeline behind `phm messages`, `phm agents
 * messages`, `phm bus recent` and their API reads: the row-level `--thread`,
 * `--in-reply-to` and `--channel` filters applied before projection, the
 * identity-resolved sender filters, the live job feed annotations, then the
 * projected-field filters — the result is every `AgentMessage` the query
 * accepts, newest first, before `--limit`; callers slice and shape it.
 * `annotateJobs` resolves the live feed state behind job citations — the
 * `jobState` field `phm messages` emits and the `--job` citation match both
 * read; a projection that never emits `jobState` passes false and still gets
 * citation matching whenever `--job` is set.
 */
export function matchAgentMessages(rows: readonly BusInboxReceipt[], query: AgentMessagesQuery,
  options: BusInboxOptions = {}, annotateJobs = true): AgentMessage[] {
  // --thread, --in-reply-to, --channel, --body-kind, --result and --to are
  // row-level filters applied before projection: the first keeps only
  // note/context bodies carrying that v2 thread label — the same
  // `busBodyThread` match
  // `agents bus inbox --thread`, `channel read --thread`, `comms bus
  // read|watch --thread` and `fleet bus-follow --thread` apply — the
  // second keeps only object bodies whose own `inReplyTo` cites the
  // named envelope — the shared `busBodyInReplyToMatch` rule `comms bus
  // read|watch --in-reply-to`, `fleet bus-follow --in-reply-to`,
  // `fleet_bus_inbox`'s `inReplyTo`, `agents bus inbox --in-reply-to` and
  // `channel read --in-reply-to` apply — the third keeps only envelopes
  // addressed to `group:<channel>:*`, the room prefix `agents bus inbox
  // --channel` and `channel read` match, decided on the raw `to` label
  // so every topic of the named room lists while agent mail and other
  // rooms never reach the page, and the fourth keeps only bodies whose
  // own kind discriminator strictly equals the value — the shared
  // `busBodyKind` match `agents bus inbox --body-kind`, `channel read
  // --body-kind`, `agents bus wakes --body-kind` and `agents
  // conversations --body-kind` apply, so a body carrying no discriminator
  // never matches. `result` keeps only `work.result` bodies whose own
  // `outcome` field strictly equals the value — the `busBodyResultOutcome`
  // own-field match the work feed's `--result` codes share, so every
  // other body kind (a `work.release` outcome included) and a result
  // carrying no outcome never matches — and the fifth keeps only
  // envelopes whose raw `to`
  // routing label the addressed-to predicate accepts — the shared
  // `agentRefAddressMatcher` rule `comms bus read|watch --to` and
  // `fleet_bus_inbox`'s `to` apply, resolving the ref through the registry
  // so every label of one identity matches while an unresolvable ref keeps
  // exact-label matching. Every other
  // body kind and a note without the field never matches the thread
  // filter, a `replyTo` alias or substring never matches the citation
  // filter, and `matched` counts only the rows they accept. `id` is the
  // exact-envelope match the raw bus reads share: only the row whose own
  // wire id equals the value passes — never a substring or a body
  // citation — so "where did envelope X go" is one filtered read of the
  // whole timeline, and `matched` counts only that row when it is set.
  const channelPrefix = query.channel === undefined ? undefined : `group:${query.channel}:`;
  const kept = rows.filter(row =>
    (query.id === undefined || row.envelope.id === query.id) &&
    (query.thread === undefined || busBodyThread(row.envelope.body) === query.thread) &&
    (query.inReplyTo === undefined || busBodyInReplyToMatch(row.envelope.body, query.inReplyTo)) &&
    (query.bodyKind === undefined || busBodyKind(row.envelope.body) === query.bodyKind) &&
    (query.result === undefined || busBodyResultOutcome(row.envelope.body) === query.result) &&
    (channelPrefix === undefined || row.envelope.to.startsWith(channelPrefix)));
  const registryRead = query.agent === undefined && query.with === undefined && query.from === undefined && query.excludeFrom === undefined && query.to === undefined
    ? undefined : readAgentRegistry({ root: options.root });
  const registry = registryRead?.status === 'ok' ? registryRead.registry : undefined;
  const identityOf = registry === undefined ? undefined : labelIdentityOf(registry);
  const refKeyFor = registry === undefined ? undefined : (ref: string) => resolveAgent(registry, ref)?.id;
  // --to is the addressed-to filter the flat bus reads share: only the rows
  // whose raw `to` label the `agentRefAddressMatcher` predicate accepts
  // survive, so "everything addressed to leaders" or "everything addressed
  // to agent X" is one filtered read of the whole fleet timeline. It needs
  // the registry the sender filters already read, so it applies after
  // `kept` rather than inside it; `matched` counts only the rows it keeps.
  const toMatch = query.to === undefined ? undefined : agentRefAddressMatcher(query.to, registry);
  const addressed = toMatch === undefined ? kept : kept.filter(row => toMatch(row.envelope.to));
  const jobIds = new Set<string>();
  for (const row of addressed) {
    const jobId = busBodyJobId(row.envelope.body);
    if (jobId !== undefined) jobIds.add(jobId);
  }
  let jobStateOf: ((jobId: string) => BusEnvelopeLookupJob) | undefined;
  if ((annotateJobs || query.job !== undefined) && jobIds.size > 0) {
    let feed: BusWorkFeedReadResult | undefined;
    try { feed = readBusWorkFeed({ root: options.root, now: options.now, claims: true }); }
    catch { feed = undefined; }
    const annotations = new Map<string, BusEnvelopeLookupJob>();
    jobStateOf = (jobId) => {
      let annotation = annotations.get(jobId);
      if (annotation === undefined) {
        annotation = feed === undefined ? { jobId, feed: 'unavailable' } : jobAnnotationFromFeed(feed, jobId);
        annotations.set(jobId, annotation);
      }
      return annotation;
    };
  }
  return filterAgentMessages(projectAgentMessages(addressed, jobStateOf), query, identityOf, refKeyFor);
}

/**
 * The one typed read behind the CLI, API and panes. `thread` keeps only
 * `note`/`context` bodies carrying that v2 thread label — the same
 * `busBodyThread` match `agents bus inbox --thread`, `agents bus channel
 * read --thread`, `comms bus read|watch --thread` and `fleet bus-follow
 * --thread` apply — filtered on the bus rows before projection so `matched`
 * counts only the rows every filter accepts. Bodies that cite a
 * job — a work-feed `jobId` or a `worker-handoff`'s `taskId` — get
 * `jobState`, the same live feed state `agents bus
 * inbox`/`show`/`work mine` resolve, from one claims-joined feed read per
 * call, only when a scanned row cites a job. A feed that cannot be read
 * annotates `unavailable` (or its own state), never a guessed job. `contains`
 * is the fleet-wide text search no other bus read offers: a case-insensitive
 * substring over each message's scrubbed one-line `summary`, applied in
 * `filterAgentMessages` so `matched` still counts only the rows every filter
 * accepts. `inReplyTo` is the reply-citation filter the raw bus reads share
 * — only an object body's own `inReplyTo` strictly equal to the cited
 * envelope id keeps the row, so the fleet timeline answers "who answered
 * envelope X" across every addressee in one read, not only the reader's
 * own mail. `id` is the exact-envelope match those same raw reads share —
 * only the row whose own wire id equals the value keeps it, so "where did
 * envelope X go" is one filtered read of the whole timeline. `bodyKind` is
 * the body-discriminator filter those same reads share — only a body whose
 * `busBodyKind` strictly equals the value keeps the row, decided on the raw
 * body before projection so "every work.post on the bus" or "every wake
 * hint" is one filtered read of the whole timeline. `result` is the
 * work-result outcome filter the feed's `--result` shares at envelope
 * granularity — only a `work.result` body whose own `outcome` strictly
 * equals the value keeps the row, decided on the raw body before
 * projection through `busBodyResultOutcome`, so every other body kind and
 * a result carrying no outcome never matches, and "every `failed` result
 * receipt the fleet reported" — including ones a job's newer status has
 * since superseded — is one filtered read of the whole timeline.
 */
export function readAgentMessages(query: AgentMessagesQuery = {}, options: BusInboxOptions = {}): AgentMessages {
  const scan = scanBusInbox(options);
  const matched = matchAgentMessages(scan.rows, query, options);
  const limit = query.limit ?? AGENT_MESSAGES_DEFAULT_LIMIT;
  return { schema: 'agent-messages.v1', source: scan.source, messages: matched.slice(0, limit), matched: matched.length, skipped: scan.skipped };
}

/** `15m`, `2h`, `1d`, epoch ms or an ISO time → epoch ms; null when unparseable. */
export function parseSince(value: string, now = Date.now()): number | null {
  const rel = /^([1-9][0-9]{0,6})(s|m|h|d)$/.exec(value);
  if (rel) return now - Number(rel[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 's' | 'm' | 'h' | 'd'];
  if (/^[0-9]{1,16}$/.test(value)) return Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const at = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** Shared validation for CLI flags and API query params. */
export function parseAgentMessagesQuery(input: { since?: string; before?: string; agent?: string; with?: string; kind?: string; priority?: string; job?: string; thread?: string; contains?: string; from?: string; excludeFrom?: string; inReplyTo?: string; channel?: string; to?: string; id?: string; bodyKind?: string; result?: string; limit?: string }, now = Date.now()):
  { ok: true; query: AgentMessagesQuery } | { ok: false; error: string } {
  const query: AgentMessagesQuery = {};
  if (input.kind !== undefined) {
    const kind = input.kind.toLowerCase();
    if (!(AGENT_MESSAGE_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `--kind takes one of ${AGENT_MESSAGE_KINDS.join(', ')}.` };
    }
    query.kind = kind as AgentMessageKind;
  }
  if (input.priority !== undefined) {
    if (!(BUS_PRIORITIES as readonly string[]).includes(input.priority)) {
      return { ok: false, error: '--priority takes P0, P1, P2 or P3.' };
    }
    query.priority = input.priority as BusPriority;
  }
  if (input.job !== undefined) {
    if (!JOB_ID.test(input.job)) {
      return { ok: false, error: '--job takes a job id (printable label, 1-128 chars).' };
    }
    query.job = input.job;
  }
  if (input.thread !== undefined) {
    if (!JOB_ID.test(input.thread)) {
      return { ok: false, error: '--thread takes a thread label (printable, 1-128 chars).' };
    }
    query.thread = input.thread;
  }
  if (input.channel !== undefined) {
    // The same strict channel-name grammar `agents bus channel create` and
    // `agents bus inbox --channel` enforce, so a value that cannot name a
    // registry room is a usage error rather than a silently empty page.
    if (!agentChannelNameSchema.safeParse(input.channel).success) {
      return { ok: false, error: '--channel takes a bus channel name (a-z, 0-9, _ -; 1-32 chars).' };
    }
    query.channel = input.channel;
  }
  if (input.contains !== undefined) {
    // Free text for a substring match, not a label: any printable content is
    // fine, bounded so a pathological needle cannot scan forever. Whitespace
    // is kept verbatim — the matcher collapses it the same way summaries do.
    if (typeof input.contains !== 'string' || input.contains.trim() === '' || input.contains.length > AGENT_MESSAGES_CONTAINS_MAX) {
      return { ok: false, error: `--contains takes a non-empty search text of at most ${AGENT_MESSAGES_CONTAINS_MAX} characters.` };
    }
    query.contains = input.contains;
  }
  if (input.since !== undefined) {
    const since = parseSince(input.since, now);
    if (since === null) return { ok: false, error: '--since takes 15m, 2h, 1d, epoch ms or an ISO time.' };
    query.since = since;
  }
  if (input.before !== undefined) {
    const before = parseSince(input.before, now);
    if (before === null) return { ok: false, error: '--before takes 15m, 2h, 1d, epoch ms or an ISO time.' };
    query.before = before;
  }
  if (input.agent !== undefined) {
    if (!/^[\x21-\x7e]{1,128}$/.test(input.agent)) return { ok: false, error: '--agent takes an agent name or lane.' };
    query.agent = input.agent;
  }
  if (input.with !== undefined) {
    if (!query.agent || !/^[\x21-\x7e]{1,128}$/.test(input.with)) return { ok: false, error: '--with takes the other agent and needs --agent.' };
    query.with = input.with;
  }
  if (input.from !== undefined) {
    if (!/^[\x21-\x7e]{1,128}$/.test(input.from)) return { ok: false, error: '--from takes an agent name or lane.' };
    query.from = input.from;
  }
  if (input.excludeFrom !== undefined) {
    if (!/^[\x21-\x7e]{1,128}$/.test(input.excludeFrom)) return { ok: false, error: '--exclude-from takes an agent name or lane.' };
    query.excludeFrom = input.excludeFrom;
  }
  if (input.to !== undefined) {
    // The addressed-to ref shares the sender refs' printable-label bound; the
    // value may be any routing label — an agent ref or a bare address like
    // `leaders` — resolved through the registry at match time, never here.
    if (!/^[\x21-\x7e]{1,128}$/.test(input.to)) return { ok: false, error: '--to takes an agent name, lane or routing label.' };
    query.to = input.to;
  }
  if (input.inReplyTo !== undefined) {
    if (!JOB_ID.test(input.inReplyTo)) {
      return { ok: false, error: '--in-reply-to takes an envelope id (printable label, 1-128 chars).' };
    }
    query.inReplyTo = input.inReplyTo;
  }
  if (input.id !== undefined) {
    if (!JOB_ID.test(input.id)) {
      return { ok: false, error: '--id takes an envelope id (printable label, 1-128 chars).' };
    }
    query.id = input.id;
  }
  if (input.bodyKind !== undefined) {
    // The same printable-label bound every bus read's body-kind filter
    // applies — the value is matched verbatim against `busBodyKind`, never
    // normalized, so case and spelling decide exactly like the flag does.
    if (!JOB_ID.test(input.bodyKind)) {
      return { ok: false, error: '--body-kind takes a body kind (printable, 1-128 chars).' };
    }
    query.bodyKind = input.bodyKind;
  }
  if (input.result !== undefined) {
    // The same WORK_RESULT_OUTCOMES enum the work feed's --result filter
    // validates — an unknown outcome is a usage error, never a silent
    // empty page, so the flag can never disagree with the feed about
    // which codes a work.result body can report.
    if (!(WORK_RESULT_OUTCOMES as readonly string[]).includes(input.result)) {
      return { ok: false, error: `--result takes one of ${WORK_RESULT_OUTCOMES.join(', ')}.` };
    }
    query.result = input.result as WorkResultOutcome;
  }
  if (input.limit !== undefined) {
    const limit = Number(input.limit);
    if (!/^[1-9][0-9]*$/.test(input.limit) || limit > AGENT_MESSAGES_MAX_LIMIT) return { ok: false, error: `--limit takes 1..${AGENT_MESSAGES_MAX_LIMIT}.` };
    query.limit = limit;
  }
  return { ok: true, query };
}

export function formatAgentMessagesText(result: AgentMessages): string {
  if (result.source === 'unavailable') return 'Messages: unknown (the agent bus could not be read).';
  const lines = result.messages.map(m => {
    const who = (a: AgentRef) => `${a.name} (${a.lane ?? 'lane unknown'})`;
    const link = [m.job, m.pr].filter(Boolean).join(' ');
    const job = m.jobState === undefined ? '' : ` ${busInboxJobMarker(m.jobState)}`;
    return `${m.ts.slice(0, 19).replace('T', ' ')}  ${m.priority} ${m.kind.padEnd(7)} ${who(m.from)} → ${who(m.to)}: ${m.summary}${link ? `  [${link}]` : ''}${job}`;
  });
  const head = result.messages.length === 0 ? 'No agent messages.' : `${result.messages.length} of ${result.matched} messages, newest first.`;
  const tail = result.skipped > 0 ? [`Skipped ${result.skipped} damaged bus record${result.skipped === 1 ? '' : 's'}.`] : [];
  return [head, ...lines, ...tail].join('\n');
}
