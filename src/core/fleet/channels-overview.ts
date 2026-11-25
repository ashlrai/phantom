/**
 * `phm channels` (no verb) — one row per messaging channel the owner can reach
 * the Leader on: is it connected, when did it last carry a message each way,
 * how busy was it in the last 24 h, how many senders are verified, and the one
 * plain next step when it is not connected.
 *
 * No second registry: the channel list is RECEIVER_CHANNELS (channel-envelope),
 * the inbox channels' setup state is `buildChannelsStatus` (channels.ts), and
 * Slack/iMessage state is `readChannelHealth` (channel-health.ts). This module
 * only joins those reads.
 *
 * Every fact enters through a `ChannelsReader`, so `buildChannelsOverview` is
 * pure and tests feed fixtures. Raw addresses (chat ids, phone handles, email
 * senders, Slack team ids) are masked here with the existing `maskHandle`
 * redactor, and free text has home paths and emails redacted: no full token,
 * number or address leaves this module. A source that cannot be read reports
 * 'unknown', never a guessed zero.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { loadConfigReadOnly } from '../config.js';
import { readEmailDropConfig } from '../comms/email-drop-config.js';
import { buildSlackBridgeStatus } from '../agents/slack-status.js';
import { redactEmails, redactHomePaths } from '../util/scrub.js';
import { createRemoteDeviceStore } from '../web/remote-device-store.js';
import { RECEIVER_CHANNELS, type ReceiverChannel } from './channel-envelope.js';
import {
  CHANNELS_OVERVIEW_SCHEMA,
  CHANNELS_OVERVIEW_VERSION,
  type ChannelOverviewRow,
  type ChannelOverviewState,
  type ChannelsOverview,
  type Unknowable,
} from './channels-schema.js';
import {
  defaultChannelSources,
  readChannelHealth,
  type ChannelHealthReport,
  type ChannelName,
  type ChannelSource,
} from './channel-health.js';
import { buildChannelsStatus, channelKindForSource, emailPairedCount, type ChannelsStatus } from './channels.js';
import { readInboxEntries } from './mason-inbox.js';
import { maskHandle } from './teammate-status.js';

export * from './channels-schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything the overview needs, read once. Raw values: redaction happens in the builder. */
export interface ChannelFacts {
  now: Date;
  /** `phm channels status` rows (email, telegram, mobile, desktop, page, cli). */
  status: ChannelsStatus;
  /** Inbox rows (`at`, `source`) used for 24 h counts; null when the inbox could not be read. */
  inbox: { at: string; source: string }[] | null;
  /** Slack/iMessage health; null when the read itself failed. */
  health: ChannelHealthReport | null;
  /** Slack/iMessage inbound and reply times (ISO); 'unknown' when the receipt store was unreadable. */
  relay: Record<ChannelName, { inbound: Unknowable<string[]>; replies: Unknowable<string[]> }>;
  verified: { email: Unknowable<number>; mobile: Unknowable<number>; slack: Unknowable<number>; imessage: Unknowable<number> };
  emailConfig: 'ok' | 'missing' | 'invalid';
  /** Raw addresses; the builder masks every one. */
  addresses: Partial<Record<ReceiverChannel, string[]>>;
}

export type ChannelsReader = () => Promise<ChannelFacts>;

const LABELS: Record<ReceiverChannel, string> = {
  email: 'Email', telegram: 'Telegram', imessage: 'iMessage', mobile: 'Mobile',
  desktop: 'Desktop app', page: 'Phantom page', cli: 'Terminal', slack: 'Slack',
};

const STATE_ORDER: Record<ChannelOverviewState, number> = { failing: 0, unknown: 1, 'not-set-up': 2, connected: 3 };

/** Inbox `at` is the local wall clock "YYYY-MM-DD HH:MM"; anything else is tried as ISO. */
export function parseInboxAt(at: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(at.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Date.parse(at);
}

function newest(times: Unknowable<string[]>): Unknowable<string | null> {
  if (times === 'unknown') return 'unknown';
  let best = Number.NEGATIVE_INFINITY;
  for (const t of times) { const ms = Date.parse(t); if (Number.isFinite(ms) && ms > best) best = ms; }
  return Number.isFinite(best) ? new Date(best).toISOString() : null;
}

function within24h(times: Unknowable<string[]>, nowMs: number, parse: (t: string) => number = Date.parse): Unknowable<number> {
  if (times === 'unknown') return 'unknown';
  return times.filter((t) => { const ms = parse(t); return Number.isFinite(ms) && ms <= nowMs && nowMs - ms < DAY_MS; }).length;
}

function maskAddress(values: string[] | undefined): string | null {
  const list = (values ?? []).map((v) => v.trim()).filter(Boolean);
  if (list.length === 0) return null;
  return list.length === 1 ? maskHandle(list[0]!) : `${maskHandle(list[0]!)} +${list.length - 1}`;
}

/**
 * Reasons and next steps are fixed strings from the status/health readers
 * that may quote a config path or an address, never a secret value (those
 * readers check presence only). Redact both; a secret-shape scrub here would
 * mangle the plain words ("token in TELEGRAM_BOT_TOKEN").
 */
function plain(text: string | null | undefined): string | null {
  return text ? redactEmails(redactHomePaths(text)) : null;
}

const RELAY_NEXT: Record<ChannelName, { setUp: string; down: string; waiting: string }> = {
  slack: {
    setUp: 'run `phm channels slack status` — it names the missing Slack piece',
    down: 'start the bridge: `phm channels slack run --seconds 300`',
    waiting: 'a Slack message is waiting for a reply — `phm channels slack status`',
  },
  imessage: {
    setUp: 'run `phm imessage doctor`, then set comms.imessageHandle in ~/.ashlr/config.json',
    down: 'run `phm imessage poll --apply` to take waiting texts',
    waiting: 'a text is waiting for a reply — `phm fleet channel-health`',
  },
};

function relayRow(channel: ChannelName, facts: ChannelFacts, nowMs: number): ChannelOverviewRow {
  const relay = facts.relay[channel];
  const health = facts.health?.channels.find((c) => c.channel === channel);
  let state: ChannelOverviewState;
  let reason: string | null = null;
  let next: string | null = null;
  if (!health) {
    state = 'unknown';
    reason = `${LABELS[channel]} health could not be read`;
    next = 'run `phm fleet channel-health` for the detail';
  } else if (health.state === 'LIVE') {
    state = 'connected';
  } else if (health.state === 'BLOCKED' && !health.configured) {
    state = 'not-set-up';
    next = RELAY_NEXT[channel].setUp;
  } else if (health.state === 'BLOCKED' || health.state === 'DEGRADED') {
    state = 'failing';
    reason = health.missing[0] ?? (health.state === 'DEGRADED' ? `${channel} reply overdue` : `${channel} blocked`);
    next = health.processAlive === false ? RELAY_NEXT[channel].down : RELAY_NEXT[channel].waiting;
  } else {
    state = 'unknown';
    reason = health.missing[0] ?? `${channel} state could not be verified`;
    next = 'run `phm fleet channel-health` for the detail';
  }
  return {
    channel, label: LABELS[channel], state, reason: plain(reason),
    lastInboundAt: newest(relay.inbound),
    lastOutboundAt: newest(relay.replies),
    messages24h: within24h(relay.inbound, nowMs),
    verifiedSenders: facts.verified[channel],
    address: maskAddress(facts.addresses[channel]),
    next: plain(next),
  };
}

/** Pure: facts in, redacted overview out. */
export function buildChannelsOverview(facts: ChannelFacts): ChannelsOverview {
  const nowMs = facts.now.getTime();
  const inboxBy = new Map<ReceiverChannel, string[]>();
  for (const entry of facts.inbox ?? []) {
    const kind = channelKindForSource(entry.source);
    if (kind === 'other') continue;
    const list = inboxBy.get(kind) ?? [];
    list.push(entry.at);
    inboxBy.set(kind, list);
  }

  const rows: ChannelOverviewRow[] = [];
  for (const channel of RECEIVER_CHANNELS) {
    if (channel === 'slack' || channel === 'imessage') {
      rows.push(relayRow(channel, facts, nowMs));
      continue;
    }
    const row = facts.status.channels.find((r) => r.kind === channel);
    if (!row) {
      rows.push({
        channel, label: LABELS[channel], state: 'unknown', reason: 'no status reader for this channel',
        lastInboundAt: 'unknown', lastOutboundAt: 'unknown', messages24h: 'unknown', verifiedSenders: 'unknown',
        address: null, next: null,
      });
      continue;
    }
    let state: ChannelOverviewState;
    let reason: string | null = null;
    if (row.ready) state = 'connected';
    else if (channel === 'email' && facts.emailConfig === 'invalid') { state = 'failing'; reason = 'email-drop config is invalid'; }
    else if (row.configured) { state = 'failing'; reason = row.credential === 'missing' ? `${LABELS[channel]} credential is missing` : `${LABELS[channel]} is not ready`; }
    else state = 'not-set-up';

    const lastSeenMs = typeof row.lastSeenAt === 'string' && row.lastSeenAt !== 'unknown' ? parseInboxAt(row.lastSeenAt) : NaN;
    const verifiedSenders: Unknowable<number> | null =
      channel === 'email' ? facts.verified.email
        : channel === 'telegram' ? (row.paired === 'unknown' ? 'unknown' : row.paired === true ? 1 : 0)
          : channel === 'mobile' ? facts.verified.mobile
            : null;
    rows.push({
      channel, label: LABELS[channel], state, reason: plain(reason),
      lastInboundAt: row.lastSeenAt === 'unknown' ? 'unknown'
        : row.lastSeenAt === null ? null
          : Number.isFinite(lastSeenMs) ? new Date(lastSeenMs).toISOString() : 'unknown',
      // No per-channel delivery receipt exists for these yet: honest unknown.
      lastOutboundAt: 'unknown',
      messages24h: facts.inbox === null ? 'unknown' : within24h(inboxBy.get(channel) ?? [], nowMs, parseInboxAt),
      verifiedSenders,
      address: maskAddress(facts.addresses[channel]),
      next: state === 'connected' ? null : plain(row.next ?? null),
    });
  }

  rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || RECEIVER_CHANNELS.indexOf(a.channel) - RECEIVER_CHANNELS.indexOf(b.channel));
  const counts: Record<ChannelOverviewState, number> = { connected: 0, 'not-set-up': 0, failing: 0, unknown: 0 };
  for (const row of rows) counts[row.state]++;
  return {
    schema: CHANNELS_OVERVIEW_SCHEMA,
    version: CHANNELS_OVERVIEW_VERSION,
    at: facts.now.toISOString(),
    counts,
    channels: rows,
  };
}

// ---------------------------------------------------------------------------
// Default reader — real files, read-only. Never sends, never reads a secret value.
// ---------------------------------------------------------------------------

export interface DefaultChannelsReaderOptions {
  cfg?: AshlrConfig;
  homeDir?: string;
  runsDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Slack/iMessage sources (tests); defaults to channel-health's own. */
  sources?: Record<ChannelName, ChannelSource>;
  /** Active paired phone devices (tests); defaults to the remote-device registry. */
  mobileDevices?: () => number;
}

async function settle<T>(fn: () => T | Promise<T>): Promise<Unknowable<T>> {
  try { return await fn(); } catch { return 'unknown'; }
}

export function createDefaultChannelsReader(opts: DefaultChannelsReaderOptions = {}): ChannelsReader {
  return async () => {
    const now = (opts.now ?? (() => new Date()))();
    const homeDir = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? join(homeDir, '.ashlr-runs');
    let cfg: AshlrConfig;
    try { cfg = opts.cfg ?? loadConfigReadOnly(); } catch { cfg = {} as AshlrConfig; }

    const inboxRead = await readInboxEntries({ runsDir, limit: Number.MAX_SAFE_INTEGER });
    const status = await buildChannelsStatus({ cfg, homeDir, runsDir, ...(opts.env ? { env: opts.env } : {}), now: () => now, inbox: inboxRead });
    const emailDrop = await readEmailDropConfig(runsDir);

    // Wrap the health sources so the inbound/reply times health reads anyway
    // also feed the 24 h counts — one read per store.
    const base = opts.sources ?? defaultChannelSources(runsDir);
    type Seen = { inbound?: Unknowable<string[]>; replies?: Unknowable<string[]> };
    const seen: Record<ChannelName, Seen> = { slack: {}, imessage: {} };
    const wrapped = {} as Record<ChannelName, ChannelSource>;
    for (const name of ['slack', 'imessage'] as const) {
      const src = base[name];
      const mark = seen[name];
      const record = async (key: keyof Seen, read: () => string[] | Promise<string[]>): Promise<string[]> => {
        try { const v = await read(); mark[key] = v; return v; } catch (e) { mark[key] = 'unknown'; throw e; }
      };
      const inboundEvidence = src.inboundEvidence?.bind(src);
      wrapped[name] = {
        ...src,
        inbound: () => record('inbound', () => src.inbound()),
        replies: () => record('replies', () => src.replies()),
        ...(inboundEvidence ? {
          inboundEvidence: async () => {
            try {
              const ev = await inboundEvidence();
              mark.inbound = ev.store === 'ok' ? ev.rows.map((r) => r.at) : 'unknown';
              return ev;
            } catch (e) { mark.inbound = 'unknown'; throw e; }
          },
        } : {}),
      };
    }
    let health: ChannelHealthReport | null;
    try { health = await readChannelHealth({ now: () => now, sources: wrapped, runsDir }); } catch { health = null; }
    // Health stops early for an unconfigured or stopped bridge; read what it skipped.
    const relay = {} as ChannelFacts['relay'];
    for (const name of ['slack', 'imessage'] as const) {
      const src = wrapped[name];
      if (seen[name].inbound === undefined) await settle(() => (src.inboundEvidence ? src.inboundEvidence() : src.inbound()));
      if (seen[name].replies === undefined) await settle(() => src.replies());
      relay[name] = { inbound: seen[name].inbound ?? 'unknown', replies: seen[name].replies ?? 'unknown' };
    }

    const slackStatus = await settle(() => buildSlackBridgeStatus({ runsDir }));
    const imessageHandle = typeof cfg.comms?.imessageHandle === 'string' ? cfg.comms.imessageHandle : '';
    const telegramChat = typeof cfg.comms?.telegram?.chatId === 'string' ? cfg.comms.telegram.chatId : '';
    return {
      now,
      status,
      inbox: inboxRead.sourceState === 'degraded' ? null : inboxRead.entries.map((e) => ({ at: e.at, source: e.source })),
      health,
      relay,
      verified: {
        email: await settle(() => emailPairedCount(runsDir)),
        mobile: await settle(opts.mobileDevices ?? (() => createRemoteDeviceStore().list().filter((d) => d.revokedAt === null).length)),
        slack: slackStatus === 'unknown' ? 'unknown' : slackStatus.teamIdentities.slack,
        imessage: imessageHandle ? 1 : 0,
      },
      emailConfig: emailDrop.state,
      addresses: {
        ...(telegramChat ? { telegram: [telegramChat] } : {}),
        ...(emailDrop.config?.from.length ? { email: emailDrop.config.from } : {}),
        ...(imessageHandle ? { imessage: [imessageHandle] } : {}),
        ...(slackStatus !== 'unknown' && slackStatus.bridge?.teamId ? { slack: [slackStatus.bridge.teamId] } : {}),
      },
    };
  };
}

export async function readChannelsOverview(reader: ChannelsReader = createDefaultChannelsReader()): Promise<ChannelsOverview> {
  return buildChannelsOverview(await reader());
}
