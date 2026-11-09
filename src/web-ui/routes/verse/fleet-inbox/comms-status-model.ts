/** The Comms agent's state for the Inbox pane (GET /api/verse/fleet/comms-status). Counts only — no draft text, addresses or paths cross the wire. */
export const COMMS_STATUS_PATH = '/api/verse/fleet/comms-status';

export interface CommsDraftsStatus {
  pending: number;
  oldestPendingAt: string | null;
}

export interface CommsEmailOutboxStatus {
  configured: boolean;
  queued: number;
  drafted: number;
  sent: number;
  stuck: number;
  stuckReasons: Record<string, number>;
}

export interface IMessageStatus {
  configuration: { state: string; reason: string };
  chatDb: { state: string; reason: string };
  cursor: { state: string; reason: string };
  ackSource: string;
  lastAckAt: string | null;
  acks24h: number;
  nextStep: string | null;
}

/** Whether Mason has confirmed the send limits. Counts and channel names only. */
export interface SendPolicyStatus {
  confirmed: boolean;
  teamIdentities: number;
  channels: string[];
}

export interface CommsStatus {
  generatedAt: string;
  sendPolicy: SendPolicyStatus | null;
  imessage: IMessageStatus | null;
  drafts: CommsDraftsStatus | null;
  emailOutbox: CommsEmailOutboxStatus | null;
  sources: {
    drafts: 'healthy' | 'degraded';
    emailOutbox: 'healthy' | 'missing' | 'degraded';
  };
}

/** The card's display lines: a drafts line, an email line, an optional stuck-reasons line, and whether to show the setup hint. */
export interface CommsStatusLines {
  drafts: string;
  email: string;
  stuckReasons: string | null;
  showEmailDropHint: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function readDrafts(value: unknown): CommsDraftsStatus | null {
  if (!isRecord(value)) return null;
  if (!isCount(value.pending)) return null;
  if (value.oldestPendingAt !== null && typeof value.oldestPendingAt !== 'string') return null;
  return { pending: value.pending, oldestPendingAt: value.oldestPendingAt as string | null };
}

function readEmailOutbox(value: unknown): CommsEmailOutboxStatus | null {
  if (!isRecord(value) || typeof value.configured !== 'boolean') return null;
  if (!isCount(value.queued) || !isCount(value.drafted) || !isCount(value.sent) || !isCount(value.stuck)) return null;
  const reasons: Record<string, number> = {};
  if (!isRecord(value.stuckReasons)) return null;
  for (const [reason, count] of Object.entries(value.stuckReasons)) {
    if (!isCount(count)) return null;
    reasons[reason] = count;
  }
  return { configured: value.configured, queued: value.queued, drafted: value.drafted, sent: value.sent, stuck: value.stuck, stuckReasons: reasons };
}

function readIMessage(value: unknown): IMessageStatus | null {
  if (!isRecord(value)) return null;
  const field = (v: unknown): v is { state: string; reason: string } =>
    isRecord(v) && typeof v.state === 'string' && typeof v.reason === 'string';
  if (!field(value.configuration) || !field(value.chatDb) || !field(value.cursor)
    || typeof value.ackSource !== 'string' || !isCount(value.acks24h)
    || (value.lastAckAt !== null && (typeof value.lastAckAt !== 'string' || !Number.isFinite(Date.parse(value.lastAckAt))))
    || (value.nextStep !== null && typeof value.nextStep !== 'string')) return null;
  return { configuration: value.configuration, chatDb: value.chatDb, cursor: value.cursor,
    ackSource: value.ackSource, lastAckAt: value.lastAckAt as string | null,
    acks24h: value.acks24h, nextStep: value.nextStep as string | null };
}

function readSendPolicy(value: unknown): SendPolicyStatus | null {
  if (!isRecord(value) || typeof value.confirmed !== 'boolean' || !isCount(value.teamIdentities)) return null;
  if (!Array.isArray(value.channels) || !value.channels.every(c => typeof c === 'string')) return null;
  return { confirmed: value.confirmed, teamIdentities: value.teamIdentities, channels: value.channels as string[] };
}

/** Strict narrowing: a response that fails the shape is absent, never repaired. */
export function readCommsStatus(data: unknown): CommsStatus | null {
  if (!isRecord(data) || data.version !== 1 || typeof data.generatedAt !== 'string') return null;
  if (data.drafts !== null && readDrafts(data.drafts) === null) return null;
  if (data.emailOutbox !== null && readEmailOutbox(data.emailOutbox) === null) return null;
  const sources = data.sources;
  if (!isRecord(sources)) return null;
  if (sources.drafts !== 'healthy' && sources.drafts !== 'degraded') return null;
  if (sources.emailOutbox !== 'healthy' && sources.emailOutbox !== 'missing' && sources.emailOutbox !== 'degraded') return null;
  return {
    generatedAt: data.generatedAt,
    sendPolicy: readSendPolicy(data.sendPolicy),
    imessage: readIMessage(data.imessage),
    drafts: data.drafts === null ? null : readDrafts(data.drafts),
    emailOutbox: data.emailOutbox === null ? null : readEmailOutbox(data.emailOutbox),
    sources: { drafts: sources.drafts, emailOutbox: sources.emailOutbox },
  };
}

/** "45 s", "25 min", "3 h", "2 d" — the age the drafts line shows. */
export function ageText(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

/** Display lines for a validated response. A degraded section reads "unavailable" — never a fake zero. */
export function commsStatusLines(status: CommsStatus, now: number): CommsStatusLines {
  let drafts: string;
  if (status.drafts === null) drafts = 'Drafts unavailable';
  else if (status.drafts.pending === 0) drafts = 'No drafts waiting';
  else {
    const count = `${status.drafts.pending} draft${status.drafts.pending === 1 ? '' : 's'} waiting for you`;
    drafts = status.drafts.oldestPendingAt === null
      ? count
      : `${count} (oldest ${ageText(status.drafts.oldestPendingAt, now)})`;
  }

  const outbox = status.emailOutbox;
  let email: string;
  let stuckReasons: string | null = null;
  let showEmailDropHint = false;
  if (outbox === null) email = 'Email replies unavailable';
  else if (!outbox.configured) {
    email = 'Email drop not set up';
    showEmailDropHint = true;
  } else {
    email = `Email replies: ${outbox.queued} queued · ${outbox.drafted} drafted · ${outbox.sent} sent · ${outbox.stuck} stuck`;
    if (outbox.stuck > 0) {
      const reasons = Object.entries(outbox.stuckReasons)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${count} ${reason}`)
        .join(' · ');
      stuckReasons = `Stuck: ${reasons || `${outbox.stuck} unclassified`}`;
    }
  }

  return { drafts, email, stuckReasons, showEmailDropHint };
}

export function imessageStatusLine(status: IMessageStatus, now: number): string {
  if (status.configuration.state === 'configured' && status.chatDb.state === 'readable' && status.cursor.state === 'present') {
    const ack = status.ackSource === 'ok' && status.lastAckAt !== null
      ? `last ack ${ageText(status.lastAckAt, now)} ago` : 'last ack unknown';
    return `iMessage · reading Messages · ${ack}`;
  }
  let problem = 'unknown';
  if (status.configuration.state === 'disabled') problem = 'not configured';
  else if (status.configuration.state === 'unknown') problem = 'configuration unknown';
  else if (status.chatDb.reason === 'DB_ACCESS_BLOCKED') problem = "can't read Messages (Full Disk Access)";
  else if (status.chatDb.state === 'unavailable') problem = "can't read Messages";
  else if (status.chatDb.state !== 'readable') problem = 'Messages access unknown';
  else if (status.cursor.state !== 'present') problem = 'reading position unknown';
  return `iMessage · ${problem}${status.nextStep ? ` · ${status.nextStep}` : ''}`;
}

/** The send-policy line. Mason confirms by editing the file himself; this only reports. */
export function sendPolicyLine(policy: SendPolicyStatus): string {
  if (policy.teamIdentities === 0) {
    return 'Team sends: no team identity is allowlisted in ~/.ashlr/agent-network.toml, so every send is refused.';
  }
  if (!policy.confirmed) {
    return 'Team sends: drafts only. You have not confirmed ~/.ashlr/comms.toml yet. Outside people are never sendable from here.';
  }
  const count = `${policy.teamIdentities} team ${policy.teamIdentities === 1 ? 'identity' : 'identities'}`;
  return `Team sends: confirmed by you · ${count}${policy.channels.length > 0 ? ` (${policy.channels.join(', ')})` : ''}`;
}
