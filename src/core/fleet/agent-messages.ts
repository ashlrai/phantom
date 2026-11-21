/**
 * Agent-to-agent messages: one read-only projection of the durable bus inbox
 * (bus-inbox.ts), shared by `phm messages`, GET /api/verse/agent-bus/messages,
 * the desktop Messages pane and the Org pane's "talking now" lines. Not a second
 * bus: nothing here writes. Addresses are routing labels, not authenticated
 * identities, and every emitted string passes the shared secret scrub.
 */
import { scrubSecrets } from '../util/scrub.js';
import { PROVIDERS } from '../agents/bus-v2-schema.js';
import { busBodySummary, busInboxJobMarker, jobAnnotationFromFeed, workFeedJobId,
  type BusEnvelopeLookupJob } from '../agents/bus-unified.js';
import { readBusWorkFeed, type BusWorkFeedReadResult } from '../agents/bus-work-feed-read.js';
import { agentIdentityKeys, BUS_CLIS, type AgentIdentityKeyFor } from '../agents/bus-identity.js';
import { scanBusInbox, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';

export const AGENT_MESSAGE_KINDS = ['ask', 'reply', 'handoff', 'status', 'blocker'] as const;
export type AgentMessageKind = typeof AGENT_MESSAGE_KINDS[number];
export const AGENT_MESSAGES_MAX_LIMIT = 1024;
export const AGENT_MESSAGES_DEFAULT_LIMIT = 50;
/** Conversation key prefix for messages about one job (`job:<jobId>`). */
export const JOB_THREAD_PREFIX = 'job:';
const SUMMARY_MAX = 160;

export interface AgentRef { name: string; lane: string | null }
/** Key order is the JSON contract: keep it stable. */
export interface AgentMessage {
  id: string; ts: string; from: AgentRef; to: AgentRef; kind: AgentMessageKind;
  summary: string; conversation: string; job: string | null; pr: string | null;
  /**
   * Present only when the body declares a work-feed `jobId` citation
   * (`work.post`, `work.status`, `work.result` or `wake`): the same live
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
/** `with` narrows `agent` to the two-way talk between that agent and one other; `kind` keeps one classified kind. */
export interface AgentMessagesQuery { since?: number; agent?: string; with?: string; kind?: AgentMessageKind; limit?: number }

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
 * `jobStateOf` resolves the live feed state behind a body's declared
 * `jobId` citation (`work.post`, `work.status`, `work.result` or `wake`);
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
    const feedJobId = jobStateOf === undefined ? undefined : workFeedJobId(envelope.body);
    const jobState = feedJobId === undefined || jobStateOf === undefined ? undefined : jobStateOf(feedJobId);
    // work.* operations keep their terse field formats; every other kind the
    // bus knows summarizes through the same one-line composer the inbox frame
    // uses, so `phm messages`, conversations and the map never show a bare
    // kind name where the frame would show the payload.
    const raw = workText(body) ?? busBodySummary(body) ?? bodyText(body) ?? str(body?.kind) ?? (typeof envelope.body === 'string' ? envelope.body : null);
    const summary = raw ? clip(oneLine(raw)) : '';
    const from = agentName(envelope.from), to = agentName(envelope.to);
    return {
      id: oneLine(envelope.id), ts: new Date(row.receivedAt).toISOString(),
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
 * filter. An unresolvable side changes nothing.
 */
export function filterAgentMessages(messages: readonly AgentMessage[], query: AgentMessagesQuery,
  identityOf?: AgentIdentityKeyFor): AgentMessage[] {
  const want = (value: string | undefined) => value ? agentName(value).toLowerCase() : null;
  const agent = want(query.agent), peer = want(query.with);
  const agentKey = identityOf && query.agent ? identityOf(agentName(query.agent)) : undefined;
  const peerKey = identityOf && query.with ? identityOf(agentName(query.with)) : undefined;
  const is = (ref: AgentRef, name: string, key: string | undefined) =>
    ref.name.toLowerCase() === name || ref.lane === name || (key !== undefined && identityOf?.(ref.name) === key);
  return messages.filter(m => (query.since === undefined || Date.parse(m.ts) >= query.since)
    && (query.kind === undefined || m.kind === query.kind)
    && (!agent || (peer ? (is(m.from, agent, agentKey) && is(m.to, peer, peerKey)) || (is(m.from, peer, peerKey) && is(m.to, agent, agentKey)) : is(m.from, agent, agentKey) || is(m.to, agent, agentKey))));
}

/**
 * The one typed read behind the CLI, API and panes. Bodies that cite a
 * work-feed `jobId` get `jobState` — the same live feed state `agents bus
 * inbox`/`show`/`work mine` resolve — from one claims-joined feed read per
 * call, only when a scanned row cites a job. A feed that cannot be read
 * annotates `unavailable` (or its own state), never a guessed job.
 */
export function readAgentMessages(query: AgentMessagesQuery = {}, options: BusInboxOptions = {}): AgentMessages {
  const scan = scanBusInbox(options);
  const identityOf = query.agent === undefined && query.with === undefined ? undefined
    : agentIdentityKeys({ root: options.root });
  const jobIds = new Set<string>();
  for (const row of scan.rows) {
    const jobId = workFeedJobId(row.envelope.body);
    if (jobId !== undefined) jobIds.add(jobId);
  }
  let jobStateOf: ((jobId: string) => BusEnvelopeLookupJob) | undefined;
  if (jobIds.size > 0) {
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
  const matched = filterAgentMessages(projectAgentMessages(scan.rows, jobStateOf), query, identityOf);
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
export function parseAgentMessagesQuery(input: { since?: string; agent?: string; with?: string; kind?: string; limit?: string }, now = Date.now()):
  { ok: true; query: AgentMessagesQuery } | { ok: false; error: string } {
  const query: AgentMessagesQuery = {};
  if (input.kind !== undefined) {
    const kind = input.kind.toLowerCase();
    if (!(AGENT_MESSAGE_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `--kind takes one of ${AGENT_MESSAGE_KINDS.join(', ')}.` };
    }
    query.kind = kind as AgentMessageKind;
  }
  if (input.since !== undefined) {
    const since = parseSince(input.since, now);
    if (since === null) return { ok: false, error: '--since takes 15m, 2h, 1d, epoch ms or an ISO time.' };
    query.since = since;
  }
  if (input.agent !== undefined) {
    if (!/^[\x21-\x7e]{1,128}$/.test(input.agent)) return { ok: false, error: '--agent takes an agent name or lane.' };
    query.agent = input.agent;
  }
  if (input.with !== undefined) {
    if (!query.agent || !/^[\x21-\x7e]{1,128}$/.test(input.with)) return { ok: false, error: '--with takes the other agent and needs --agent.' };
    query.with = input.with;
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
    return `${m.ts.slice(0, 19).replace('T', ' ')}  ${m.kind.padEnd(7)} ${who(m.from)} → ${who(m.to)}: ${m.summary}${link ? `  [${link}]` : ''}${job}`;
  });
  const head = result.messages.length === 0 ? 'No agent messages.' : `${result.messages.length} of ${result.matched} messages, newest first.`;
  const tail = result.skipped > 0 ? [`Skipped ${result.skipped} damaged bus record${result.skipped === 1 ? '' : 's'}.`] : [];
  return [head, ...lines, ...tail].join('\n');
}
