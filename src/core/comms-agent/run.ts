/**
 * One Comms pass: route a lane, triage the local inbox, archive bulk and bot
 * mail, and put every reply through the send policy. A delivered reply also
 * resolves its inbox message into the archive — never a resend — so pending
 * depth counts only mail still awaiting a reply. Delivery uses a
 * ChannelAdapter or a sanctioned LinkedIn connector. This module opens no
 * network client of its own.
 */
import { createHash } from 'node:crypto';
import { CHANNEL_IDS, type ChannelAdapter, type ChannelId, type DeliverResult } from '../agents/channel-policy.js';
import { getChannelAdapter, listChannelRegistry } from '../agents/channel-registry.js';
import { readLocalSendPolicy } from '../agents/send-gate.js';
import { createDraft } from '../cos/drafts.js';
import { scrubSecrets } from '../util/scrub.js';
import { COMMS_AGENT_ROLE } from './role.js';
import {
  decideSend, readKillState, readPauseState,
  type CommsTransport, type KillState, type LinkedInMode, type SendAttempt, type StandingApproval,
} from './policy.js';
import { routeCommsLane } from './route.js';
import {
  appendArchive, appendDraft, appendOwnerNotice, appendRunRecord, appendSendLog, listDrafts, readInbox, readOwnerApprovals, readRunJournal, readSendLog, writeInbox,
  type ApprovalsReason, type CommsDraft, type CommsRunRecord, type OwnerApprovals,
} from './store.js';
import { triageInbox, type InboxMessage, type TriageSummary } from './triage.js';

export interface LinkedInConnector {
  mode: 'official-api' | 'sanctioned-connector';
  deliver: (attempt: SendAttempt) => Promise<DeliverResult>;
}

export interface CommsRunOptions {
  runsDir: string;
  lanes?: readonly string[];
  now?: () => string;
  kill?: () => KillState;
  paused?: () => boolean;
  /**
   * `injected` is the test seam. CLI and MCP leave this unset, which reads only
   * the fixed owner file and refuses an approvals or owners override.
   */
  approvalsSource?: 'owner-file' | 'injected';
  approvals?: readonly StandingApproval[];
  owners?: readonly string[];
  /** Team identities used to label an envelope. Unset reads the owner policy file. */
  teamIdentities?: readonly { channel: string; id: string }[];
  deliver?: (attempt: SendAttempt) => Promise<DeliverResult>;
  adapters?: Partial<Record<ChannelId, ChannelAdapter>>;
  linkedin?: LinkedInConnector;
  /** Skip the router when the caller already chose. Tests use this. */
  lane?: { lane: string | null; reason: string };
}

export interface CommsRunReport {
  ok: true;
  schema: 'comms-agent.run.v1';
  role: typeof COMMS_AGENT_ROLE.id;
  parentRole: typeof COMMS_AGENT_ROLE.parentRole;
  lane: string | null;
  laneReason: string;
  grokRequired: false;
  triage: { kept: number; archived: number; drafted: number; deleted: 0 };
  /** One entry per inbox message the pass classified — id, mail class and
   * the scrubbed one-line summary — so the report says which mail was kept,
   * archived or drafted, not only how many. */
  summaries: TriageSummary[];
  sends: Array<{ transport: CommsTransport; recipient: string; status: DeliverResult['status']; reason: string }>;
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+$/;

function isChannelId(value: string): value is ChannelId {
  return (CHANNEL_IDS as readonly string[]).includes(value);
}

/** True when the recipient is not an explicit team identity on that channel. */
export function envelopeExternal(transport: string, recipient: string, team: readonly { channel: string; id: string }[]): boolean {
  const id = recipient.trim();
  return !team.some(member => member.channel === transport && member.id === id);
}

function envelope(attempt: SendAttempt, channel: ChannelId, team: readonly { channel: string; id: string }[]) {
  return {
    id: `comms-${createHash('sha256').update(`${channel}\n${attempt.recipient}\n${attempt.text}`).digest('hex').slice(0, 32)}`,
    from: 'comms',
    to: attempt.recipient,
    priority: 'P2' as const,
    ttl: 60_000,
    body: { kind: 'comms-reply', text: attempt.text },
    channel,
    channel_ref: 'comms-agent',
    sender: { agent_id: 'comms', vendor: 'phantom', human: false, team: true },
    external: envelopeExternal(channel, attempt.recipient, team),
    origin_bridge: 'comms-agent',
  };
}

function teamFrom(options: CommsRunOptions): readonly { channel: string; id: string }[] {
  if (options.teamIdentities !== undefined) return options.teamIdentities;
  try { return readLocalSendPolicy().teamIdentities; }
  catch { return []; }
}

export function defaultDeliver(options: CommsRunOptions): (attempt: SendAttempt) => Promise<DeliverResult> {
  return async attempt => {
    if (attempt.transport === 'linkedin') {
      const connector = options.linkedin;
      const mode: LinkedInMode = attempt.linkedinMode ?? 'unspecified';
      if (!connector || connector.mode !== mode) {
        return { status: 'drafted', reason: 'No sanctioned LinkedIn connector is registered.' };
      }
      const stopped = halted(options);
      if (stopped) return stopped;
      return connector.deliver(attempt);
    }
    if (!isChannelId(attempt.transport)) return { status: 'drafted', reason: 'No channel adapter is available.' };
    const adapter = options.adapters?.[attempt.transport] ?? getChannelAdapter(attempt.transport);
    if (!adapter || adapter.id !== attempt.transport) return { status: 'drafted', reason: 'No channel adapter is available.' };
    const stopped = halted(options);
    if (stopped) return stopped;
    return adapter.deliver(envelope(attempt, attempt.transport, teamFrom(options)));
  };
}

function draftId(attempt: SendAttempt): string {
  return `c-${createHash('sha256').update(`${attempt.transport}\n${attempt.recipient}\n${attempt.text}`).digest('hex').slice(0, 16)}`;
}

async function rememberDraft(runsDir: string, attempt: SendAttempt, at: string, messageId: string): Promise<void> {
  const draft: CommsDraft = {
    id: draftId(attempt),
    status: 'pending',
    transport: attempt.transport,
    recipient: attempt.recipient.trim(),
    subject: attempt.subject?.slice(0, 300) || (attempt.transport === 'email' ? 'Reply' : `${attempt.transport} reply`),
    body: attempt.text,
    messageId,
    createdAt: at,
  };
  // One pending record per unique reply: a repeated pass over the same kept
  // message must not append a second draft or owner notice. A 'sent' record
  // does not block a fresh pending draft for the same reply.
  const recorded = await listDrafts(runsDir);
  if (!recorded.some(row => row.id === draft.id && row.status === 'pending')) {
    await appendDraft(runsDir, draft);
    await appendOwnerNotice(runsDir, {
      at, kind: 'draft', draftId: draft.id, transport: draft.transport, recipient: draft.recipient,
    });
  }
  if (draft.transport === 'email' && EMAIL.test(draft.recipient)) {
    try {
      await createDraft({
        to: draft.recipient,
        subject: draft.subject,
        body: draft.body,
        source: `comms-agent:${draft.id}`,
      }, runsDir);
    } catch { /* The Comms draft and owner-thread notice still stand. */ }
  }
}

/**
 * A delivered reply resolves its draft record. Bookkeeping never rewrites a
 * completed send: a store failure leaves the pending record visible rather
 * than reporting a sent reply as failed. Every delivered reply leaves a
 * 'sent' record — a reply that was never pending gets one too — so a later
 * pass over the same kept message resolves it without resending.
 */
async function resolveSentDraft(runsDir: string, attempt: SendAttempt, at: string, messageId: string): Promise<void> {
  try {
    const id = draftId(attempt);
    const recorded = (await listDrafts(runsDir)).find(row => row.id === id);
    if (recorded?.status === 'sent') return;
    const draft: CommsDraft = recorded ?? {
      id,
      status: 'pending',
      transport: attempt.transport,
      recipient: attempt.recipient.trim(),
      subject: attempt.subject?.slice(0, 300) || (attempt.transport === 'email' ? 'Reply' : `${attempt.transport} reply`),
      body: attempt.text,
      messageId,
      createdAt: at,
    };
    await appendDraft(runsDir, { ...draft, status: 'sent', resolvedAt: at });
  } catch { /* See above: the send already happened. */ }
}

function gate(options: CommsRunOptions): { kill: KillState; paused: boolean } {
  return {
    kill: (options.kill ?? readKillState)(),
    paused: (options.paused ?? readPauseState)(),
  };
}

function halted(options: CommsRunOptions): DeliverResult | null {
  const now = gate(options);
  if (now.kill !== 'inactive') return { status: 'refused', reason: 'KILL halts all sends.' };
  if (now.paused) return { status: 'refused', reason: 'Communications are paused.' };
  return null;
}

async function approvalsFor(options: CommsRunOptions): Promise<OwnerApprovals | DeliverResult> {
  if ((options.approvalsSource ?? 'owner-file') !== 'injected') {
    if (options.approvals !== undefined || options.owners !== undefined) {
      return { status: 'refused', reason: 'Approval overrides are refused.' };
    }
    return readOwnerApprovals();
  }
  return { approvals: [...(options.approvals ?? [])], owners: [...(options.owners ?? [])], accepted: true, reason: 'ok' };
}

export async function executeSend(
  attempt: SendAttempt,
  options: CommsRunOptions & { messageId?: string },
): Promise<DeliverResult> {
  const loaded = await approvalsFor(options);
  if ('status' in loaded) return loaded;
  if (!loaded.accepted && loaded.reason !== 'missing' && loaded.reason !== 'malformed') {
    return { status: 'refused', reason: 'Standing approvals file is not a private owner file.' };
  }
  const at = (options.now ?? (() => new Date().toISOString()))();
  const decision = decideSend(attempt, { ...gate(options), approvals: loaded.approvals });
  if (decision.status !== 'sent') {
    if (decision.status === 'drafted') await rememberDraft(options.runsDir, attempt, at, options.messageId ?? attempt.recipient);
    return decision;
  }
  const freshApprovals = (options.approvalsSource ?? 'owner-file') === 'injected' ? loaded : await readOwnerApprovals();
  if ('accepted' in freshApprovals && !freshApprovals.accepted && freshApprovals.reason !== 'missing' && freshApprovals.reason !== 'malformed') {
    return { status: 'refused', reason: 'Standing approvals file is not a private owner file.' };
  }
  const lastGate = gate(options);
  const confirmed = decideSend(attempt, { ...lastGate, approvals: freshApprovals.approvals });
  if (confirmed.status !== 'sent') {
    if (confirmed.status === 'drafted') await rememberDraft(options.runsDir, attempt, at, options.messageId ?? attempt.recipient);
    return confirmed;
  }
  const deliver = options.deliver ?? defaultDeliver(options);
  let outcome: DeliverResult;
  try {
    outcome = await deliver(attempt);
  } catch {
    outcome = { status: 'drafted', reason: 'Delivery outcome unknown; reconcile before retry.' };
  }
  if (outcome.status !== 'sent') {
    if (outcome.status === 'drafted') await rememberDraft(options.runsDir, attempt, at, options.messageId ?? attempt.recipient);
    return outcome;
  }
  // The 'sent' draft record is the per-reply delivery evidence a later pass
  // dedupes on, so it lands before the audit append. A send-log store failure
  // is bookkeeping too: it cannot rewrite a completed send, and throwing here
  // would leave the reply pending and resend it on the next pass.
  await resolveSentDraft(options.runsDir, attempt, at, options.messageId ?? attempt.recipient);
  try {
    await appendSendLog(options.runsDir, {
      at,
      transport: attempt.transport,
      recipient: attempt.recipient.trim(),
      credentialHandle: attempt.credentialHandle ?? null,
      result: 'sent',
    });
  } catch { /* See above: the send already happened. */ }
  return outcome;
}

export async function runCommsAgent(options: CommsRunOptions): Promise<CommsRunReport> {
  if ((options.approvalsSource ?? 'owner-file') !== 'injected' && (options.approvals !== undefined || options.owners !== undefined)) {
    throw new Error('Approval overrides are refused.');
  }
  const lane = options.lane ?? routeCommsLane(options.lanes ?? []);
  const config = (options.approvalsSource ?? 'owner-file') === 'injected'
    ? { approvals: options.approvals ?? [], owners: [...(options.owners ?? [])], accepted: true, reason: 'ok' as const }
    : await readOwnerApprovals();
  const inbox = await readInbox(options.runsDir);
  const triage = triageInbox(inbox.messages, config.owners);
  for (const message of triage.archived) {
    await appendArchive(options.runsDir, inbox.rows.find(row => row.id === message.id) ?? { ...message });
  }
  await writeInbox(options.runsDir, triage.kept, inbox.rows);
  // A draft already marked sent — by an approved pass or an earlier run —
  // resolves its message without another delivery attempt; the sent record
  // is the only per-reply delivery evidence this store keeps.
  const sentDraftIds = new Set((await listDrafts(options.runsDir))
    .filter(draft => draft.status === 'sent').map(draft => draft.id));
  const resolved = new Set<string>();
  const sends: CommsRunReport['sends'] = [];
  for (const draft of triage.drafts) {
    const attempt: SendAttempt = {
      transport: draft.transport,
      recipient: draft.recipient,
      subject: draft.subject,
      text: draft.body,
      ...(draft.transport === 'linkedin' ? { linkedinMode: 'official-api' as const } : {}),
    };
    if (sentDraftIds.has(draftId(attempt))) {
      resolved.add(draft.messageId);
      sends.push({ transport: attempt.transport, recipient: attempt.recipient, status: 'sent', reason: 'Reply already delivered; resolved without resending.' });
      continue;
    }
    const outcome = await executeSend(attempt, {
      ...options,
      approvals: options.approvalsSource === 'injected' ? config.approvals : undefined,
      owners: options.approvalsSource === 'injected' ? config.owners : undefined,
      messageId: draft.messageId,
    });
    sends.push({ transport: attempt.transport, recipient: attempt.recipient, status: outcome.status, reason: outcome.reason });
    if (outcome.status === 'sent') {
      resolved.add(draft.messageId);
      // The sent mark lands inside executeSend, but this pass's snapshot
      // predates it: without the add, a second inbox row drafting the same
      // unique reply would deliver it again before the pass ends.
      sentDraftIds.add(draftId(attempt));
    }
  }
  // A delivered reply answers its message: the row moves to the archive —
  // nothing is deleted — and leaves the pending inbox, so `status` depth
  // counts only mail still awaiting a reply and no later pass resends it.
  if (resolved.size > 0) {
    for (const message of triage.kept) {
      if (resolved.has(message.id)) {
        await appendArchive(options.runsDir, inbox.rows.find(row => row.id === message.id) ?? { ...message });
      }
    }
    await writeInbox(options.runsDir, triage.kept.filter(message => !resolved.has(message.id)), inbox.rows);
  }
  const report: CommsRunReport = {
    ok: true,
    schema: 'comms-agent.run.v1',
    role: COMMS_AGENT_ROLE.id,
    parentRole: COMMS_AGENT_ROLE.parentRole,
    lane: lane.lane,
    laneReason: lane.reason,
    grokRequired: false,
    triage: {
      kept: triage.kept.filter(message => !resolved.has(message.id)).length,
      archived: triage.archived.length + resolved.size,
      drafted: sends.filter(send => send.status === 'drafted').length,
      deleted: 0,
    },
    summaries: triage.summaries,
    sends,
  };
  // The run journal is the pass's own audit record: `status` reads it to say
  // when the role last completed a pass. Like the send log, a bookkeeping
  // failure cannot rewrite a completed pass — the work already happened —
  // so the append is best-effort and the report still returns.
  const record: CommsRunRecord = {
    at: (options.now ?? (() => new Date().toISOString()))(),
    schema: report.schema,
    lane: report.lane,
    laneReason: report.laneReason,
    triage: report.triage,
    sends: report.sends,
    summaries: report.summaries,
  };
  try { await appendRunRecord(options.runsDir, record); }
  catch { /* See above: bookkeeping never rewrites a completed pass. */ }
  return report;
}

export async function commsStatus(runsDir: string, deps: {
  /** Standing-approvals reader seam; default reads the fixed owner file. */
  readApprovals?: () => Promise<OwnerApprovals>;
} = {}): Promise<{
  ok: true;
  schema: 'comms-agent.status.v1';
  role: typeof COMMS_AGENT_ROLE;
  kill: KillState;
  paused: boolean;
  /** Pending inbox messages still awaiting triage; null when the inbox file
   * cannot be read — an unreadable store is unknown, never an empty inbox. */
  inbox: number | null;
  /** Pending drafts; null when the drafts log cannot be read. */
  drafts: number | null;
  /** Completed sends logged; null when the send log cannot be read. */
  sendsLogged: number | null;
  /** Registered channel adapters; null when the registry cannot be read. */
  adapters: string[] | null;
  /** Standing-approvals file trust verdict — the same read `run` applies
   * before any send. `approvalCount`/`ownerCount` count config entries only;
   * recipients and owners are handles and never leave the file. Null when the
   * owner file cannot be read at all — the verdict is unknown, never guessed. */
  standingApprovals: {
    accepted: boolean;
    reason: ApprovalsReason;
    approvalCount: number;
    ownerCount: number;
  } | null;
  /** The last pass that completed, from the run journal `run` appends to.
   * `source` is 'missing' when no pass ever completed (a verified-empty
   * journal), 'available' when a record was read, and 'unavailable' when the
   * journal cannot be read or holds no readable record — a pass may have run,
   * the answer is unknown, never reported as never-ran. `run` is null unless
   * source is 'available'. A pass that failed mid-flight appends nothing, so
   * a stale `at` is itself the signal that passes are not completing.
   * `summaries` carries the pass's per-message triage decisions; it is null
   * on records written before the field existed — those passes recorded
   * counts only, so the decisions are unknown, never reported as none. */
  lastRun: {
    source: 'missing' | 'available' | 'unavailable';
    run: {
      at: string;
      lane: string | null;
      laneReason: string;
      kept: number;
      archived: number;
      drafted: number;
      sendOutcomes: { sent: number; drafted: number; refused: number };
      summaries: TriageSummary[] | null;
    } | null;
  };
}> {
  const [inbox, drafts, sends, approvals, journal] = await Promise.all([
    readInbox(runsDir).then(read => read.messages.length).catch(() => null),
    listDrafts(runsDir).then(rows => rows.filter(draft => draft.status === 'pending').length).catch(() => null),
    readSendLog(runsDir).then(rows => rows.length).catch(() => null),
    (deps.readApprovals ?? readOwnerApprovals)().then(found => ({
      accepted: found.accepted,
      reason: found.reason,
      approvalCount: found.approvals.length,
      ownerCount: found.owners.length,
    })).catch(() => null),
    readRunJournal(runsDir).then(read => {
      if (read.status === 'missing') return { source: 'missing' as const, run: null };
      if (read.record === null) return { source: 'unavailable' as const, run: null };
      const record = read.record;
      const sendOutcomes = { sent: 0, drafted: 0, refused: 0 };
      for (const send of record.sends) sendOutcomes[send.status] += 1;
      return { source: 'available' as const, run: {
        at: record.at,
        lane: record.lane,
        laneReason: record.laneReason,
        kept: record.triage.kept,
        archived: record.triage.archived,
        drafted: record.triage.drafted,
        sendOutcomes,
        summaries: record.summaries ?? null,
      } };
    }).catch(() => ({ source: 'unavailable' as const, run: null })),
  ]);
  let adapters: string[] | null = null;
  try { adapters = listChannelRegistry().filter(row => row.adapterRegistered).map(row => row.id); }
  catch { adapters = null; }
  return {
    ok: true,
    schema: 'comms-agent.status.v1',
    role: COMMS_AGENT_ROLE,
    kill: readKillState(),
    paused: readPauseState(),
    inbox,
    drafts,
    sendsLogged: sends,
    adapters,
    standingApprovals: approvals,
    lastRun: journal,
  };
}

/** Status slices the drafts read can select; the default stays `pending`. */
export const COMMS_DRAFT_STATUSES = ['pending', 'sent', 'all'] as const;
export type CommsDraftStatusFilter = (typeof COMMS_DRAFT_STATUSES)[number];

/** Longest `--contains` needle the drafts read accepts; the subject/body text it matches is already bounded far shorter. */
export const COMMS_DRAFTS_CONTAINS_MAX = 512;
/** Longest `--to` recipient the drafts read accepts — the send policy's own recipient bound. */
export const COMMS_DRAFTS_TO_MAX = 256;
/** Largest page `--limit` returns — the unified inbox's own item cap. */
export const COMMS_DRAFTS_LIMIT_MAX = 200;

export interface CommsDraftsFilter {
  /** `pending` (default) lists only owner approvals; `sent` lists delivered
   * replies with their `resolvedAt`; `all` lists both. */
  status?: CommsDraftStatusFilter;
  /** Narrow to one transport (`email`, `imessage`, `linkedin`, `bus`,
   * `slack`, `telegram`, `handoff`). */
  transport?: CommsTransport;
  /** Keep only drafts addressed to this exact recipient — the same exact
   * transport+recipient pairing standing approvals apply, never a
   * case-folded or substring match. */
  to?: string;
  /** Keep only drafts whose scrubbed subject or body carries the needle as a
   * case-insensitive substring; whitespace collapses on both sides so a
   * phrase typed across a line break still finds its draft. Transport,
   * recipient, ids and timestamps are not search text — `transport`, `to`,
   * `id`, `since` and `before` cover those. */
  contains?: string;
  /** Keep only drafts whose `createdAt` stamp is at or after this epoch ms;
   * `before` is the exclusive upper bound, composing into one
   * [since, before) window on when the reply was drafted — never on
   * `resolvedAt`, which only a sent record carries. A record whose
   * `createdAt` does not parse can prove no window membership, so it drops
   * out under either bound rather than guessing a time. */
  since?: number;
  before?: number;
  /** Keep only the draft whose id strictly equals this value. */
  id?: string;
  /** Cap the returned page, oldest first; `matched` still reports the true
   * filtered total. */
  limit?: number;
}

export interface CommsDraftsResult {
  ok: true;
  drafts: CommsDraft[];
  /** The true filtered total before `limit` clipped the page. */
  matched: number;
  truncated: boolean;
}

/**
 * The `--contains` verdict for one draft: the scrubbed subject and body —
 * the only free-text fields a draft carries — lowercased with whitespace
 * collapsed like every shared `--contains` haystack, so a secret-shaped
 * value stays unfindable even though it sits in the stored record.
 */
function commsDraftContainsMatch(draft: CommsDraft, needle: string): boolean {
  return scrubSecrets(`${draft.subject}\n${draft.body}`)
    .toLowerCase().replace(/\s+/g, ' ').includes(needle);
}

/**
 * The normalized form of a `contains` filter value: lowercase, whitespace
 * collapsed, trimmed — the same fold `busReadContainsNeedle` applies. An
 * absent or blank needle matches everything.
 */
function commsDraftsNeedle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const needle = value.toLowerCase().replace(/\s+/g, ' ').trim();
  return needle === '' ? undefined : needle;
}

export async function commsDrafts(runsDir: string, filter: CommsDraftsFilter = {}): Promise<CommsDraftsResult> {
  const status = filter.status ?? 'pending';
  const to = filter.to?.trim();
  const needle = commsDraftsNeedle(filter.contains);
  const hasWindow = filter.since !== undefined || filter.before !== undefined;
  const matched = (await listDrafts(runsDir)).filter(draft => {
    if (status !== 'all' && draft.status !== status) return false;
    if (filter.transport !== undefined && draft.transport !== filter.transport) return false;
    if (to !== undefined && to !== '' && draft.recipient !== to) return false;
    if (needle !== undefined && !commsDraftContainsMatch(draft, needle)) return false;
    if (filter.id !== undefined && draft.id !== filter.id) return false;
    if (hasWindow) {
      const created = Date.parse(draft.createdAt);
      if (!Number.isFinite(created)
          || (filter.since !== undefined && created < filter.since)
          || (filter.before !== undefined && created >= filter.before)) return false;
    }
    return true;
  });
  const limit = filter.limit;
  const page = limit === undefined ? matched : matched.slice(0, Math.max(0, limit));
  return { ok: true, drafts: page, matched: matched.length, truncated: page.length < matched.length };
}

export function preservedIds(before: readonly InboxMessage[], kept: readonly InboxMessage[], archived: readonly InboxMessage[]): boolean {
  const after = new Set([...kept, ...archived].map(message => message.id));
  return before.length === after.size && before.every(message => after.has(message.id));
}
