/**
 * One-read channel health for the Slack and iMessage bridges. Composes existing
 * readers (Slack status + journal + send receipts, iMessage config + ack log +
 * last-send receipt) and a process check. It never sends, never reads a
 * credential value, and never infers liveness from prose: only receipts and a
 * process check count. Each source is injectable; a source that throws makes
 * the channel UNKNOWN rather than guessed.
 */
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { buildSlackBridgeStatus } from '../agents/slack-status.js';
import { readSlackJournal } from '../agents/slack-journal.js';
import { ashlrHome } from '../cloud/store.js';
import { loadConfigReadOnlyStrict } from '../config.js';
import { readImessageAckEvidence } from '../comms/imessage-ack-evidence.js';
import { commsEnabled, readLastSend } from '../integrations/imessage.js';
import { readPrivateFileCapped } from '../verse/preferences.js';

export type ChannelName = 'slack' | 'imessage';
export type ChannelState = 'LIVE' | 'DEGRADED' | 'BLOCKED' | 'UNKNOWN';

export interface ChannelProof {
  /**
   * 'idle': no pending inbound inside the window -- a LIVE state then proves
   *   process and configuration health only, never that a request was answered.
   * 'unproven': pending inbound exists but no source binds a reply receipt to
   *   the request it answers, so later outbound can never clear it.
   * 'verified': reserved for sources that return per-request reply bindings;
   *   no current source provides them.
   */
  requestCoverage: 'idle' | 'unproven' | 'verified';
  /** Receipt observations dated after `asOf`; excluded from evidence entirely. */
  futureDatedCount: number;
}

export interface ChannelHealth {
  channel: ChannelName;
  configured: boolean;
  processAlive: boolean | 'unknown';
  runtimeHost: string | null;
  lastInboundAt: string | null;
  lastReplyAt: string | null;
  unansweredCount: number;
  /** Additive proof metadata: separates observed activity from verified coverage. */
  proof: ChannelProof;
  state: ChannelState;
  missing: string[];
  /** ISO time every timestamp above was read at. */
  asOf: string;
}

export interface ChannelHealthReport { schemaVersion: 1; asOf: string; channels: ChannelHealth[] }

/** One channel's evidence; every field may throw (=> UNKNOWN). Missing names only, never values. */
export interface ChannelSource {
  /** Names of absent configuration pieces; empty array means configured. */
  configMissing(): Promise<string[]> | string[];
  processAlive(): Promise<boolean | 'unknown'> | boolean | 'unknown';
  /** Inbound receive times (ISO), any order. */
  inbound(): Promise<string[]> | string[];
  /** Reply receipt times (ISO), any order. Activity observations only -- no source binds a reply to a specific inbound. */
  replies(): Promise<string[]> | string[];
}

export interface ChannelHealthDeps {
  now?: () => Date;
  host?: string;
  sources?: Partial<Record<ChannelName, ChannelSource>>;
  runsDir?: string;
}

export const INBOUND_WINDOW_MS = 60 * 60_000;
export const REPLY_GRACE_MS = 10 * 60_000;

function pgrep(pattern: string): Promise<boolean | 'unknown'> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', pattern], { timeout: 2_000 }, (err) => {
      if (!err) return resolve(true);
      resolve((err as { code?: unknown }).code === 1 ? false : 'unknown');
    });
  });
}

const isoOrNull = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Slack sent-receipt `ts` is epoch seconds; the store prunes after expiry, so this is recent evidence only. */
function slackReplyTimes(): string[] {
  const read = readPrivateFileCapped(join(ashlrHome(), 'fleet', 'slack-transport', 'messages.json'), 1024 * 1024);
  if (read === null) return [];
  if (read.truncated) throw new Error('slack-receipts-unreadable');
  const data = JSON.parse(read.text) as { messages?: Record<string, { state?: string; ts?: string }> };
  const out: string[] = [];
  for (const receipt of Object.values(data.messages ?? {})) {
    const at = receipt?.state === 'sent' && typeof receipt.ts === 'string' ? isoOrNull(Number(receipt.ts) * 1000) : null;
    if (at) out.push(at);
  }
  return out;
}

function defaultSources(runsDir?: string): Record<ChannelName, ChannelSource> {
  return {
    slack: {
      configMissing: () => {
        const status = buildSlackBridgeStatus(runsDir ? { runsDir } : {});
        const missing: string[] = [];
        if (status.config.state !== 'ok') missing.push('slack agent-network config');
        else if (status.slackSection !== 'ok') missing.push('slack config section');
        else {
          if (status.credentials.botTokenRef === null) missing.push('slack bot token reference');
          if (status.credentials.appTokenRef === null) missing.push('slack app token reference');
          if (status.mappings.length === 0) missing.push('slack channel mapping');
        }
        return missing;
      },
      processAlive: () => pgrep('channels slack run'),
      inbound: () => {
        const journal = readSlackJournal({ ...(runsDir ? { runsDir } : {}), limit: 4096 });
        if (journal.state === 'degraded') throw new Error('slack-journal-unreadable');
        return journal.entries.filter((e) => e.decision === 'ingested').map((e) => e.at);
      },
      replies: slackReplyTimes,
    },
    imessage: {
      configMissing: () => (commsEnabled(loadConfigReadOnlyStrict()) ? [] : ['imessage comms configuration']),
      processAlive: () => pgrep('imessage (poll|watch|run)|ashlr-imessage|imsg|textbot'),
      inbound: async () => {
        const ev = await readImessageAckEvidence(4096, runsDir);
        if (ev.sourceState === 'unreadable') throw new Error('imessage-acks-unreadable');
        return ev.rows.filter((r) => r.status === 'accepted').map((r) => r.timestamp);
      },
      replies: () => {
        const last = readLastSend(runsDir);
        return last?.ok && last.at ? [last.at] : [];
      },
    },
  };
}

const ms = (iso: string): number => Date.parse(iso);

async function readOne(channel: ChannelName, src: ChannelSource, now: Date, host: string): Promise<ChannelHealth> {
  const asOf = now.toISOString();
  const base: ChannelHealth = {
    channel, configured: false, processAlive: 'unknown', runtimeHost: null,
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
    proof: { requestCoverage: 'idle', futureDatedCount: 0 },
    state: 'UNKNOWN', missing: [], asOf,
  };
  let configMissing: string[];
  try { configMissing = await src.configMissing(); } catch {
    return { ...base, missing: [`${channel} configuration unreadable`] };
  }
  if (configMissing.length) {
    return { ...base, state: 'BLOCKED', missing: configMissing.map((m) => `${m} not configured`) };
  }
  base.configured = true;
  try { base.processAlive = await src.processAlive(); } catch { base.processAlive = 'unknown'; }
  if (base.processAlive === false) {
    return { ...base, state: 'BLOCKED', missing: [`${channel} bridge process not running`] };
  }
  if (base.processAlive === true) base.runtimeHost = host;
  let inbound: number[], replies: number[];
  try {
    inbound = (await src.inbound()).map(ms).filter(Number.isFinite).sort((a, b) => a - b);
    replies = (await src.replies()).map(ms).filter(Number.isFinite).sort((a, b) => a - b);
  } catch {
    return { ...base, state: 'UNKNOWN', missing: [`${channel} receipt source unreadable`] };
  }
  const nowMs = now.getTime();
  const validInbound = inbound.filter((t) => t <= nowMs);
  const validReplies = replies.filter((t) => t <= nowMs);
  base.lastInboundAt = validInbound.length ? isoOrNull(validInbound[validInbound.length - 1]!) : null;
  base.lastReplyAt = validReplies.length ? isoOrNull(validReplies[validReplies.length - 1]!) : null;
  // Timestamp order is activity evidence only: no current source binds a reply
  // receipt to the inbound it answers, so a later reply can never clear a
  // pending inbound. Future-dated observations are rejected as evidence.
  const pending = validInbound.filter((t) => nowMs - t <= INBOUND_WINDOW_MS);
  const observedReplies = validReplies.length;
  const futureDated = inbound.filter((t) => t > nowMs).length + replies.filter((t) => t > nowMs).length;
  base.unansweredCount = pending.length;
  base.proof = { requestCoverage: pending.length ? 'unproven' : 'idle', futureDatedCount: futureDated };
  if (base.processAlive === 'unknown') {
    return { ...base, state: 'UNKNOWN', missing: [`${channel} bridge process liveness unverifiable`] };
  }
  const reasons: string[] = [];
  if (pending.length && observedReplies) reasons.push(`${channel} reply correlation unavailable`);
  if (futureDated) reasons.push(`${channel} future-dated receipt ignored`);
  if (pending.some((t) => nowMs - t > REPLY_GRACE_MS)) {
    return { ...base, state: 'DEGRADED', missing: reasons };
  }
  if (reasons.length) return { ...base, state: 'UNKNOWN', missing: reasons };
  return { ...base, state: 'LIVE' };
}

export async function readChannelHealth(deps: ChannelHealthDeps = {}): Promise<ChannelHealthReport> {
  const now = (deps.now ?? (() => new Date()))();
  const host = deps.host ?? hostname();
  const defaults = deps.sources && deps.sources.slack && deps.sources.imessage ? null : defaultSources(deps.runsDir);
  const channels: ChannelHealth[] = [];
  for (const channel of ['slack', 'imessage'] as const) {
    const src = deps.sources?.[channel] ?? defaults![channel];
    channels.push(await readOne(channel, src, now, host));
  }
  return { schemaVersion: 1, asOf: now.toISOString(), channels };
}
