/** The unified comms inbox for the Inbox pane (GET /api/verse/comms/inbox). Read only; narrowing is defensive, never repairing. */
import { relativeTime } from '../../../lib/relative-time.js';
export const UNIFIED_INBOX_PATH = '/api/verse/comms/inbox?limit=20';
/** Every pending item, for the expanded Waiting list. */
export const UNIFIED_INBOX_ALL_PATH = '/api/verse/comms/inbox?limit=200';
const DETAIL_MAX = 300;
/** The CLI twin of this card. */
export const UNIFIED_INBOX_COMMAND = 'phm comms inbox';

const SOURCES = ['needs-you', 'needs-you-delivery', 'imessage', 'teammate-tasks', 'owner-thread', 'owner-delivery', 'drafts', 'bus', 'mailbox', 'board', 'conversations', 'wakes', 'seats', 'peer-dispatch', 'org-outbox', 'gmail', 'linkedin', 'requests', 'email-inbox', 'email-outbox', 'team-approvals', 'proposals', 'slack', 'slack-sends', 'leader-delivery', 'leader-network', 'coordination', 'claim-drift'] as const;
const KINDS = ['needs-you', 'needs-you-delivery', 'teammate-text', 'teammate-task', 'owner-message', 'owner-reply-undelivered', 'draft-approval', 'bus-work', 'bus-handoff', 'bus-dead-letter', 'mailbox-message', 'board-delivery', 'board-task', 'agent-thread', 'wake-hint', 'seat-handoff', 'peer-dispatch-result', 'org-membership', 'gmail-over-target', 'linkedin-message', 'comms-request', 'email-inbound', 'email-stuck', 'team-approval', 'inbox-proposal', 'slack-request', 'slack-send-unconfirmed', 'leader-message-undelivered', 'leader-request', 'leader-request-incomplete', 'leader-reply-unconfirmed', 'leader-digest-unconfirmed', 'coordination-message', 'coordination-assignment', 'coordination-return-unposted', 'claim-drift-bus', 'claim-drift-coordination', 'claim-drift-owner'] as const;
const SEVERITIES = ['info', 'warn', 'high'] as const;
const STATES = ['healthy', 'missing', 'degraded', 'unavailable'] as const;
const EXPIRES_SOON_MS = 30 * 60_000;

export type InboxSource = (typeof SOURCES)[number];
export type InboxKind = (typeof KINDS)[number];
export type InboxSeverity = (typeof SEVERITIES)[number];
export type InboxSourceState = (typeof STATES)[number];

export interface UnifiedInboxEntry {
  id: string;
  source: InboxSource;
  kind: InboxKind;
  severity: InboxSeverity;
  blocking: boolean;
  title: string;
  /** Why it waits (sender and age, subject, plan size); absent when the API sent none or a non-string. */
  detail?: string;
  since: string | null;
  expiresAt: string | null;
  act: string[];
}

export interface UnifiedInboxSources {
  /** null: the source was absent from the response. `pending` is null when
   * the source could not be read — its pending total is unknown, never 0. */
  [source: string]: { state: InboxSourceState; pending: number | null } | null;
}

export type UnifiedInboxView =
  | { unavailable: true }
  | { unavailable?: false; total: number; omitted: number; sources: UnifiedInboxSources; items: UnifiedInboxEntry[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

function readEntry(raw: unknown): UnifiedInboxEntry | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  if (!oneOf(SOURCES, raw.source) || !oneOf(KINDS, raw.kind) || !oneOf(SEVERITIES, raw.severity)) return null;
  return {
    id: raw.id, source: raw.source, kind: raw.kind, severity: raw.severity,
    blocking: raw.blocking === true, title: raw.title,
    since: isoOrNull(raw.since), expiresAt: isoOrNull(raw.expiresAt),
    act: Array.isArray(raw.act) ? raw.act.filter((a): a is string => typeof a === 'string') : [],
    // Omitted (not null) when absent so entries without a detail keep their prior shape.
    ...(typeof raw.detail === 'string' && { detail: raw.detail.slice(0, DETAIL_MAX) }),
  };
}

export function readUnifiedInboxView(data: unknown): UnifiedInboxView | null {
  if (!isRecord(data) || data.schema !== 'comms.unified-inbox.v1') return null;
  if (data.unavailable === true) return { unavailable: true };
  if (!isCount(data.total) || !isCount(data.omitted) || !isRecord(data.sources) || !Array.isArray(data.items)) return null;
  const sources: UnifiedInboxSources = {};
  for (const source of SOURCES) {
    const report = (data.sources as Record<string, unknown>)[source];
    sources[source] = isRecord(report) && oneOf(STATES, report.state) &&
      (report.pending === null || isCount(report.pending))
      ? { state: report.state, pending: report.pending } : null;
  }
  const items = data.items.map(readEntry).filter((e): e is UnifiedInboxEntry => e !== null);
  return { total: data.total, omitted: data.omitted, sources, items };
}

const SOURCE_NAMES: Record<InboxSource, string> = { 'needs-you': 'Needs you', 'needs-you-delivery': 'Needs-you delivery', imessage: 'iMessage', 'teammate-tasks': 'Teammate tasks', 'owner-thread': 'Owner thread', 'owner-delivery': 'Owner delivery', drafts: 'Drafts', bus: 'Bus', mailbox: 'Mailbox', board: 'Board', conversations: 'Conversations', wakes: 'Wakes', seats: 'Seats', 'peer-dispatch': 'Peer dispatch', 'org-outbox': 'Org outbox', gmail: 'Gmail', linkedin: 'LinkedIn', requests: 'Requests', 'email-inbox': 'Email inbox', 'email-outbox': 'Email outbox', 'team-approvals': 'Team approvals', proposals: 'Proposals', slack: 'Slack', 'slack-sends': 'Slack sends', 'leader-delivery': 'Leader delivery', 'leader-network': 'Leader network', coordination: 'Coordination', 'claim-drift': 'Claim drift' };
const ITEM_LABELS: Record<InboxSource, string> = { 'needs-you': 'Needs you', 'needs-you-delivery': 'Needs-you delivery', imessage: 'Teammate text', 'teammate-tasks': 'Teammate task', 'owner-thread': 'Owner message', 'owner-delivery': 'Undelivered reply', drafts: 'Draft', bus: 'Bus work', mailbox: 'Mailbox mail', board: 'Board item', conversations: 'Agent thread', wakes: 'Wake hint', seats: 'Seat handoff', 'peer-dispatch': 'Peer result', 'org-outbox': 'Org membership', gmail: 'Gmail inbox', linkedin: 'LinkedIn message', requests: 'Comms request', 'email-inbox': 'Inbound email', 'email-outbox': 'Stuck reply', 'team-approvals': 'Team approval', proposals: 'Proposal', slack: 'Slack request', 'slack-sends': 'Slack send', 'leader-delivery': 'Leader message', 'leader-network': 'Leader network', coordination: 'Coordination', 'claim-drift': 'Claim drift' };

/** "Needs you 3 · iMessage 1 · Drafts 0 · Bus degraded 2"; a missing source shows "—", never 0. */
export function sourceSummary(sources: UnifiedInboxSources): string {
  return SOURCES.map(source => {
    const report = sources[source] ?? null;
    if (report === null || report.state === 'missing') return `${SOURCE_NAMES[source]} —`;
    const state = report.state === 'healthy' ? '' : ` ${report.state}`;
    return `${SOURCE_NAMES[source]}${state} ${report.pending === null || report.state === 'unavailable' ? '—' : report.pending}`;
  }).join(' · ');
}

function relativeAge(iso: string, nowMs: number): string {
  return relativeTime(iso, nowMs)?.text ?? 'time unknown';
}

export function itemLine(item: UnifiedInboxEntry, nowMs: number): { label: string; title: string; age: string | null } {
  const parts: string[] = [];
  if (item.since !== null) parts.push(relativeAge(item.since, nowMs));
  if (item.expiresAt !== null) {
    const left = Date.parse(item.expiresAt) - nowMs;
    if (left <= EXPIRES_SOON_MS) parts.push(`expires in ${Math.max(0, Math.ceil(left / 60_000))}m`);
  }
  return { label: ITEM_LABELS[item.source], title: item.title, age: parts.length ? parts.join(' · ') : null };
}

const SOURCE_COMMANDS: Record<InboxSource, string> = {
  'needs-you': 'phm fleet needs', 'needs-you-delivery': 'phm fleet needs', imessage: 'phm fleet teammate-texts', 'teammate-tasks': 'phm fleet imessage-tasks list', 'owner-thread': 'phm comms thread', 'owner-delivery': 'phm comms thread',
  drafts: 'phm drafts list --status pending', bus: 'phm fleet bus-claim', mailbox: 'phm bus inbox', board: 'phm bus board pending', conversations: 'phm agents conversations',
  wakes: 'phm agents bus wakes --all',
  seats: 'phm bots handoffs', 'peer-dispatch': 'phm agentnet peers dispatch --apply', 'org-outbox': 'phm fleet org-sync --apply', gmail: 'phm fleet gmail-archive-plan', linkedin: 'phm drafts list --status pending', requests: 'phm comms status',
  'email-inbox': 'phm comms email-cycle', 'email-outbox': 'phm fleet email-outbox', 'team-approvals': 'phm approvals', proposals: 'phm inbox', slack: 'phm fleet slack-trace', 'slack-sends': 'phm channels slack status',
  'leader-delivery': 'phm channels', 'leader-network': 'phm leader inbox', coordination: 'phm fleet coordination board',
  'claim-drift': 'phm fleet claim-drift',
};
const STATE_MEANINGS: Record<Exclude<InboxSourceState, 'healthy'>, string> = {
  missing: 'not set up on this Mac', degraded: 'read partly; some items may be missing', unavailable: 'could not be read',
};

export interface SourceProblem { source: InboxSource; name: string; meaning: string; command: string }

/** One entry per source that is not healthy; a source absent from the response counts as unreadable. */
export function sourceProblems(sources: UnifiedInboxSources): SourceProblem[] {
  const problems: SourceProblem[] = [];
  for (const source of SOURCES) {
    const state = sources[source]?.state ?? 'unavailable';
    if (state === 'healthy') continue;
    problems.push({ source, name: SOURCE_NAMES[source], meaning: STATE_MEANINGS[state], command: SOURCE_COMMANDS[source] });
  }
  return problems;
}
