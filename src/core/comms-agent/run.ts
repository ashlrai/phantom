/**
 * One Comms pass: route a lane, triage the local inbox, archive bulk and bot
 * mail, and put every reply through the send policy. Delivery uses a
 * ChannelAdapter or a sanctioned LinkedIn connector. This module opens no
 * network client of its own.
 */
import { createHash } from 'node:crypto';
import { CHANNEL_IDS, type ChannelAdapter, type ChannelId, type DeliverResult } from '../agents/channel-policy.js';
import { getChannelAdapter, listChannelRegistry } from '../agents/channel-registry.js';
import { readLocalSendPolicy } from '../agents/send-gate.js';
import { createDraft } from '../cos/drafts.js';
import { COMMS_AGENT_ROLE } from './role.js';
import {
  decideSend, readKillState, readPauseState,
  type CommsTransport, type KillState, type LinkedInMode, type SendAttempt, type StandingApproval,
} from './policy.js';
import { routeCommsLane } from './route.js';
import {
  appendArchive, appendDraft, appendOwnerNotice, appendSendLog, listDrafts, readInbox, readOwnerApprovals, readSendLog, writeInbox,
  type CommsDraft, type OwnerApprovals,
} from './store.js';
import { triageInbox, type InboxMessage } from './triage.js';

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
      return connector.deliver(attempt);
    }
    if (!isChannelId(attempt.transport)) return { status: 'drafted', reason: 'No channel adapter is available.' };
    const adapter = options.adapters?.[attempt.transport] ?? getChannelAdapter(attempt.transport);
    if (!adapter || adapter.id !== attempt.transport) return { status: 'drafted', reason: 'No channel adapter is available.' };
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
  await appendDraft(runsDir, draft);
  await appendOwnerNotice(runsDir, {
    at, kind: 'draft', draftId: draft.id, transport: draft.transport, recipient: draft.recipient,
  });
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

function gate(options: CommsRunOptions): { kill: KillState; paused: boolean } {
  return {
    kill: (options.kill ?? readKillState)(),
    paused: (options.paused ?? readPauseState)(),
  };
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
  const freshGate = gate(options);
  if (freshGate.kill !== 'inactive') return { status: 'refused', reason: 'KILL halts all sends.' };
  if (freshGate.paused) return { status: 'refused', reason: 'Communications are paused.' };
  const freshApprovals = (options.approvalsSource ?? 'owner-file') === 'injected' ? loaded : await readOwnerApprovals();
  if ('accepted' in freshApprovals && !freshApprovals.accepted && freshApprovals.reason !== 'missing' && freshApprovals.reason !== 'malformed') {
    return { status: 'refused', reason: 'Standing approvals file is not a private owner file.' };
  }
  const confirmed = decideSend(attempt, { ...freshGate, approvals: freshApprovals.approvals });
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
  await appendSendLog(options.runsDir, {
    at,
    transport: attempt.transport,
    recipient: attempt.recipient.trim(),
    credentialHandle: attempt.credentialHandle ?? null,
    result: 'sent',
  });
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
  const sends: CommsRunReport['sends'] = [];
  for (const draft of triage.drafts) {
    const attempt: SendAttempt = {
      transport: draft.transport,
      recipient: draft.recipient,
      subject: draft.subject,
      text: draft.body,
      ...(draft.transport === 'linkedin' ? { linkedinMode: 'official-api' as const } : {}),
    };
    const outcome = await executeSend(attempt, {
      ...options,
      approvals: options.approvalsSource === 'injected' ? config.approvals : undefined,
      owners: options.approvalsSource === 'injected' ? config.owners : undefined,
      messageId: draft.messageId,
    });
    sends.push({ transport: attempt.transport, recipient: attempt.recipient, status: outcome.status, reason: outcome.reason });
  }
  return {
    ok: true,
    schema: 'comms-agent.run.v1',
    role: COMMS_AGENT_ROLE.id,
    parentRole: COMMS_AGENT_ROLE.parentRole,
    lane: lane.lane,
    laneReason: lane.reason,
    grokRequired: false,
    triage: {
      kept: triage.kept.length,
      archived: triage.archived.length,
      drafted: sends.filter(send => send.status === 'drafted').length,
      deleted: 0,
    },
    sends,
  };
}

export async function commsStatus(runsDir: string): Promise<{
  ok: true;
  schema: 'comms-agent.status.v1';
  role: typeof COMMS_AGENT_ROLE;
  kill: KillState;
  paused: boolean;
  drafts: number;
  sendsLogged: number;
  adapters: string[];
}> {
  const [drafts, sends] = await Promise.all([
    listDrafts(runsDir).catch(() => []),
    readSendLog(runsDir).catch(() => []),
  ]);
  let adapters: string[] = [];
  try { adapters = listChannelRegistry().filter(row => row.adapterRegistered).map(row => row.id); }
  catch { adapters = []; }
  return {
    ok: true,
    schema: 'comms-agent.status.v1',
    role: COMMS_AGENT_ROLE,
    kill: readKillState(),
    paused: readPauseState(),
    drafts: drafts.length,
    sendsLogged: sends.length,
    adapters,
  };
}

export async function commsDrafts(runsDir: string): Promise<{ ok: true; drafts: CommsDraft[] }> {
  return { ok: true, drafts: await listDrafts(runsDir) };
}

export function preservedIds(before: readonly InboxMessage[], kept: readonly InboxMessage[], archived: readonly InboxMessage[]): boolean {
  const after = new Set([...kept, ...archived].map(message => message.id));
  return before.length === after.size && before.every(message => after.has(message.id));
}
