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
import { buildSlackBridgeStatus, slackInboundRequests } from '../agents/slack-status.js';
import { readSlackJournal } from '../agents/slack-journal.js';
import { bindSlackReplies } from '../agents/slack-reply-binding.js';
import { readSlackSendReceipts } from '../agents/slack-send-receipts.js';
import { ashlrHome } from '../cloud/store.js';
import { loadConfigReadOnlyStrict } from '../config.js';
import { readImessageAckEvidence } from '../comms/imessage-ack-evidence.js';
import { commsEnabled, readLastSend } from '../integrations/imessage.js';
import { readPrivateFileCapped } from '../verse/preferences.js';

export type ChannelName = 'slack' | 'imessage';
export type ChannelState = 'LIVE' | 'DEGRADED' | 'BLOCKED' | 'UNKNOWN';

export interface ChannelProof {
  /**
   * 'idle': no inbound inside the window -- a LIVE state then proves process
   *   and configuration health only, never that a request was answered.
   * 'unproven': inbound inside the window is not proven answered. Either the
   *   source has no per-request reply binding (timestamp order alone can never
   *   clear a request), its binding was unreadable, or at least one request
   *   has no same-thread sent receipt yet.
   * 'verified': the source returned a readable per-request reply binding
   *   (`ChannelSource.replyBinding`), at least one in-window request is bound
   *   to its own same-thread sent receipt, and none is left unanswered.
   */
  requestCoverage: 'idle' | 'unproven' | 'verified';
  /**
   * In-window requests bound one-to-one to a same-thread sent receipt. Present
   * only when a readable reply binding was applied; absent means unknown.
   */
  answeredCount?: number;
  /** Receipt observations dated after `asOf`; excluded from evidence entirely. */
  futureDatedCount: number;
  /**
   * Durable bus-admission counts inside the recent inbound window. Present only
   * when the source returns per-row outcomes; absent means coverage is unknown,
   * never that admission succeeded. 'unverified' counts rows (e.g. legacy
   * journal entries) that carry no bus outcome and so prove nothing either way.
   */
  durableIngress?: DurableIngressCounts;
}

/** Per-row durable-admission tally; counts only, never identifiers or payloads. */
export interface DurableIngressCounts {
  posted: number;
  duplicate: number;
  failed: number;
  unverified: number;
}

/** Durable bus-post outcome recorded next to an ingested inbound row. */
export type InboundAdmission = 'posted' | 'duplicate' | 'failed';

/** One inbound observation; `admission` absent means durable admission is unproven. */
export interface InboundObservation {
  /** ISO receive time. */
  at: string;
  admission?: InboundAdmission;
}

export interface InboundEvidence {
  rows: InboundObservation[];
  /**
   * Observation-store coverage. 'missing' and 'unreadable' are evidence gaps:
   * they can never certify an idle healthy request path.
   */
  store: 'ok' | 'missing' | 'unreadable';
}

/**
 * Per-request reply binding, reduced to ISO inbound receive times. Ids, thread
 * refs and text never cross this boundary. `answeredAt` and `unansweredAt`
 * partition the source's inbound requests; requests the source cannot bind
 * (e.g. rows lacking ids) belong in `unansweredAt`, never `answeredAt`.
 * Only `store: 'ok'` is applied; anything else falls back to timestamp logic.
 */
export interface ReplyBindingEvidence {
  store: 'ok' | 'missing' | 'unreadable';
  answeredAt: string[];
  unansweredAt: string[];
  /** Future-dated requests/receipts the binder rejected (same observations readOne already counts). */
  futureDated: number;
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
  /**
   * Optional richer inbound read; when present it supersedes inbound(). Rows
   * carry durable-admission outcomes and `store` reports observation-store
   * coverage. Sources without it keep honest unknown coverage: no
   * durableIngress counts are invented for them.
   */
  inboundEvidence?(): Promise<InboundEvidence> | InboundEvidence;
  /** Reply receipt times (ISO), any order. Activity observations only; binding comes from replyBinding(). */
  replies(): Promise<string[]> | string[];
  /**
   * Optional per-request reply binding at `now`. When present and readable it
   * replaces timestamp-only pending logic: an answered request no longer
   * counts as unanswered, and coverage can become 'verified'. Sources without
   * it (iMessage) keep timestamp-only behavior and can never be 'verified'.
   */
  replyBinding?(now: Date): Promise<ReplyBindingEvidence> | ReplyBindingEvidence;
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

/** Slack journal rows -> inbound evidence. Only ids/outcomes survive; text, authors and error payloads never reach this surface. */
function slackInboundEvidence(runsDir?: string): InboundEvidence {
  const journal = readSlackJournal({ ...(runsDir ? { runsDir } : {}), limit: 4096 });
  if (journal.state === 'degraded') return { store: 'unreadable', rows: [] };
  if (journal.state === 'missing') return { store: 'missing', rows: [] };
  return {
    store: 'ok',
    rows: journal.entries
      .filter((e) => e.decision === 'ingested')
      .map((e) => ({ at: e.at, ...(e.bus ? { admission: e.bus } : {}) })),
  };
}

/**
 * Binds Slack journal requests to same-thread sent receipts with the same
 * construction `phm channels slack status` uses. Answered requests map back
 * to their receive time; every other ingested row (unbound, malformed or
 * id-less legacy) is reported unanswered so nothing is claimed answered
 * without a receipt.
 */
function slackReplyBinding(runsDir: string | undefined, now: Date): ReplyBindingEvidence {
  const empty = { answeredAt: [], unansweredAt: [], futureDated: 0 };
  const journal = readSlackJournal({ ...(runsDir ? { runsDir } : {}), limit: 4096 });
  if (journal.state === 'missing') return { store: 'missing', ...empty };
  if (journal.state === 'degraded') return { store: 'unreadable', ...empty };
  const sends = readSlackSendReceipts();
  // A missing send store means nothing was sent (every request unanswered);
  // a degraded one could hide receipts, so it never certifies coverage.
  if (sends.state === 'degraded') return { store: 'unreadable', ...empty };
  const requests = slackInboundRequests(journal.entries);
  const binding = bindSlackReplies({ requests, receipts: sends.receipts, now });
  const atByKey = new Map<string, string[]>();
  for (const r of requests) {
    const key = `${r.channelId}:${r.threadTs}:${r.messageTs}`;
    atByKey.set(key, [...(atByKey.get(key) ?? []), r.at]);
  }
  // The binder visits duplicate keys in ascending `at` order.
  for (const ats of atByKey.values()) ats.sort();
  const answeredAt: string[] = [];
  for (const a of binding.answered) {
    const at = atByKey.get(`${a.channelId}:${a.threadTs}:${a.messageTs}`)?.shift();
    if (at !== undefined) answeredAt.push(at);
  }
  const remaining = [...answeredAt];
  const unansweredAt: string[] = [];
  for (const e of journal.entries) {
    if (e.decision !== 'ingested') continue;
    const i = remaining.indexOf(e.at);
    if (i >= 0) remaining.splice(i, 1);
    else unansweredAt.push(e.at);
  }
  return { store: 'ok', answeredAt, unansweredAt, futureDated: binding.futureDated };
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
        const evidence = slackInboundEvidence(runsDir);
        if (evidence.store !== 'ok') throw new Error('slack-journal-unreadable');
        return evidence.rows.map((r) => r.at);
      },
      inboundEvidence: () => slackInboundEvidence(runsDir),
      replies: slackReplyTimes,
      replyBinding: (now) => slackReplyBinding(runsDir, now),
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
  let inbound: number[], replies: number[], evidence: InboundEvidence | null = null;
  try {
    if (src.inboundEvidence) {
      evidence = await src.inboundEvidence();
      inbound = evidence.rows.map((r) => ms(r.at)).filter(Number.isFinite).sort((a, b) => a - b);
    } else {
      inbound = (await src.inbound()).map(ms).filter(Number.isFinite).sort((a, b) => a - b);
    }
    replies = (await src.replies()).map(ms).filter(Number.isFinite).sort((a, b) => a - b);
  } catch {
    return { ...base, state: 'UNKNOWN', missing: [`${channel} receipt source unreadable`] };
  }
  // A binding failure is not a receipt-source failure: fall back to timestamp
  // logic (never 'verified') and say so.
  let binding: ReplyBindingEvidence | null = null;
  let bindingUnreadable = false;
  if (src.replyBinding) {
    try {
      const read = await src.replyBinding(now);
      if (read.store === 'ok') binding = read;
      else bindingUnreadable = true;
    } catch { bindingUnreadable = true; }
  }
  const nowMs = now.getTime();
  const validInbound = inbound.filter((t) => t <= nowMs);
  const validReplies = replies.filter((t) => t <= nowMs);
  base.lastInboundAt = validInbound.length ? isoOrNull(validInbound[validInbound.length - 1]!) : null;
  base.lastReplyAt = validReplies.length ? isoOrNull(validReplies[validReplies.length - 1]!) : null;
  // Without a readable per-request binding, timestamp order is activity
  // evidence only: a later reply can never clear a pending inbound. With one,
  // only requests lacking their own same-thread sent receipt stay pending.
  // Future-dated observations are rejected as evidence either way.
  const inWindow = (t: number): boolean => Number.isFinite(t) && t <= nowMs && nowMs - t <= INBOUND_WINDOW_MS;
  const windowInbound = validInbound.filter(inWindow);
  const pending = binding ? binding.unansweredAt.map(ms).filter(inWindow) : windowInbound;
  const answeredCount = binding ? binding.answeredAt.map(ms).filter(inWindow).length : 0;
  const observedReplies = validReplies.length;
  // binding.futureDated re-counts these same journal/receipt observations, so
  // it is deliberately not added here.
  const futureDated = inbound.filter((t) => t > nowMs).length + replies.filter((t) => t > nowMs).length;
  base.unansweredCount = pending.length;
  const proof: ChannelProof = {
    requestCoverage: pending.length ? 'unproven'
      : binding && answeredCount > 0 ? 'verified'
        : windowInbound.length ? 'unproven' : 'idle',
    futureDatedCount: futureDated,
    ...(binding ? { answeredCount } : {}),
  };
  // Durable-admission tally over the same recent window that can block LIVE.
  // Rows without an outcome (legacy) are 'unverified': they neither prove a
  // successful durable enqueue nor convict one. A 'failed' row is positive
  // evidence the running socket could not durably enqueue the request.
  let durableFailed = false;
  if (evidence !== null && evidence.store === 'ok') {
    const counts: DurableIngressCounts = { posted: 0, duplicate: 0, failed: 0, unverified: 0 };
    for (const row of evidence.rows) {
      const t = ms(row.at);
      if (!Number.isFinite(t) || t > nowMs || nowMs - t > INBOUND_WINDOW_MS) continue;
      if (row.admission === 'posted') counts.posted += 1;
      else if (row.admission === 'duplicate') counts.duplicate += 1;
      else if (row.admission === 'failed') { counts.failed += 1; durableFailed = true; }
      else counts.unverified += 1;
    }
    proof.durableIngress = counts;
  }
  base.proof = proof;
  // A missing or degraded observation store is an evidence gap, not an idle
  // healthy request path: it can never produce LIVE.
  if (evidence !== null && evidence.store !== 'ok') {
    return {
      ...base,
      state: 'UNKNOWN',
      missing: [evidence.store === 'missing' ? `${channel} inbound journal missing` : `${channel} receipt source unreadable`],
    };
  }
  if (base.processAlive === 'unknown') {
    return { ...base, state: 'UNKNOWN', missing: [`${channel} bridge process liveness unverifiable`] };
  }
  const reasons: string[] = [];
  if (!binding && pending.length && observedReplies) reasons.push(`${channel} reply correlation unavailable`);
  if (futureDated) reasons.push(`${channel} future-dated receipt ignored`);
  if (durableFailed) reasons.push(`${channel} durable ingress failed`);
  // The binding-unreadable reason is reported but never changes the state the
  // timestamp fallback would have produced on its own.
  const reported = bindingUnreadable ? [...reasons, `${channel} reply binding unreadable`] : reasons;
  if (pending.some((t) => nowMs - t > REPLY_GRACE_MS) || durableFailed) {
    return { ...base, state: 'DEGRADED', missing: reported };
  }
  if (reasons.length) return { ...base, state: 'UNKNOWN', missing: reported };
  return { ...base, state: 'LIVE', missing: reported };
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
