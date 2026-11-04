/**
 * RQ-PHX-DAILYBRIEFSEND04: one short daily fleet summary per channel, on a
 * local-day budget — `ashlr fleet brief-send` dry-runs, `--apply` sends.
 *
 *   planDailyBrief({ runsDir, now, lastSent }) — for each channel ('email',
 *     'telegram') yields { send: true, text } or { send: false, reason }.
 *     Text is the existing status composer output (email-fleet-status /
 *     telegram-fleet-status) led by the needs-you count, bounded to
 *     DAILY_BRIEF_MAX_CHARS of plain text. Skip reasons:
 *     'already-sent-today', 'not-configured', 'status-unavailable'.
 *   queue/daily-brief-last.json — the stamp: { email?: 'YYYY-MM-DD',
 *     telegram?: 'YYYY-MM-DD' } in America/New_York local date. A channel
 *     stamped today is skipped; the stamp is written only after a send
 *     succeeds, via writePrivateFileAtomic under the local store lock — the
 *     same claim-then-record shape order-merge-notice uses.
 *   applyDailyBriefPlan(runsDir, plan, senders) — re-reads the stamp under
 *     the lock so an overlapping run can never double-send, sends each
 *     sendable entry, stamps successes. Unconfigured channels are skipped,
 *     never errors.
 *
 * Email sends by queueing `daily-brief-<day>.reply.eml` in the email-drop
 * outbox (a config with exactly one `from` sender is required, same as order
 * notices); `ashlr fleet email-outbox --send` / `phm comms cycle` delivers.
 * Telegram sends through sendTelegramMessage, enabled only when
 * telegramEnabled says the transport is configured. No token, chat id or
 * address is ever printed or returned.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfigReadOnly } from '../config.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readNeedsMason } from '../fleet/needs-mason-resolve.js';
import { sendTelegramMessage, telegramEnabled } from '../integrations/telegram.js';
import type { AshlrConfig } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { readEmailDropConfig } from './email-drop-config.js';
import { emailFleetStatus, type EmailFleetStatusReaders } from './email-fleet-status.js';
import { telegramFleetStatus, type TelegramFleetStatusDeps } from './telegram-fleet-status.js';

export const DAILY_BRIEF_CHANNELS = ['email', 'telegram'] as const;
export type DailyBriefChannel = (typeof DAILY_BRIEF_CHANNELS)[number];
export const DAILY_BRIEF_MAX_CHARS = 1200;
export const DAILY_BRIEF_STAMP = join('queue', 'daily-brief-last.json');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Per-channel last-sent local dates (America/New_York 'YYYY-MM-DD'). */
export interface DailyBriefLastSent {
  email?: string;
  telegram?: string;
}

export type DailyBriefSkipReason = 'already-sent-today' | 'not-configured' | 'status-unavailable';
export type DailyBriefPlanEntry =
  | { channel: DailyBriefChannel; send: true; text: string }
  | { channel: DailyBriefChannel; send: false; reason: DailyBriefSkipReason };

export interface DailyBriefPlan {
  /** Local day the plan applies to (America/New_York 'YYYY-MM-DD'). */
  day: string;
  entries: DailyBriefPlanEntry[];
}

/** One sender per channel; a send succeeds by returning, fails by throwing. */
export type DailyBriefSender = (text: string) => Promise<void>;
export type DailyBriefSenders = Partial<Record<DailyBriefChannel, DailyBriefSender>>;

export interface DailyBriefApplied {
  channel: DailyBriefChannel;
  outcome: 'sent' | 'skipped' | 'failed';
  reason?: string;
}

/** 'YYYY-MM-DD' in the operator's zone; falls back to UTC on a bad clock. */
export function dailyBriefLocalDay(at: Date, timeZone = 'America/New_York'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const p = (type: string): string => parts.find(part => part.type === type)?.value ?? '00';
    return `${p('year')}-${p('month')}-${p('day')}`;
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Needs-you count first, then the allowlisted composer text, ≤1200 chars. */
export function dailyBriefText(needs: number | null, status: string): string {
  const head = `Needs you: ${needs === null || !Number.isSafeInteger(needs) || needs < 0 ? 'unavailable' : needs}`;
  const body = scrubSecrets(String(status)).replace(/\r\n?/g, '\n').trim();
  if (!body) return head;
  const room = DAILY_BRIEF_MAX_CHARS - head.length - 1;
  if (body.length <= room) return `${head}\n${body}`;
  const cut = body.slice(0, room).replace(/\n[^\n]*$/, '');
  return cut ? `${head}\n${cut}` : head;
}

/** Malformed or absent stamps dedupe nothing. */
export function readDailyBriefStamp(runsDir: string): DailyBriefLastSent {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(runsDir, DAILY_BRIEF_STAMP), 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const stamp: DailyBriefLastSent = {};
  for (const channel of DAILY_BRIEF_CHANNELS) {
    const value = (raw as Record<string, unknown>)[channel];
    if (typeof value === 'string' && DAY.test(value)) stamp[channel] = value;
  }
  return stamp;
}

function defaultNeedsYou(runsDir: string): number | null {
  try {
    const result = readNeedsMason({ runsDir });
    return result.status === 'unavailable' ? null : result.items.length;
  } catch {
    return null;
  }
}

/**
 * Configured means a send could be attempted right now: email needs a valid
 * drop config naming exactly one recipient (the outbox gate refuses
 * multi-recipient replies); Telegram needs telegramEnabled. Anything else is
 * 'not-configured', never an error.
 */
async function defaultIsConfigured(runsDir: string, channel: DailyBriefChannel): Promise<boolean> {
  if (channel === 'email') {
    try {
      const { state, config } = await readEmailDropConfig(runsDir);
      return state === 'ok' && !!config && config.from.length === 1;
    } catch {
      return false;
    }
  }
  try {
    return telegramEnabled(loadConfigReadOnly());
  } catch {
    return false;
  }
}

async function defaultComposeStatus(
  runsDir: string,
  channel: DailyBriefChannel,
  now: () => Date,
  readers: DailyBriefPlanDeps['readers'],
): Promise<string> {
  return channel === 'email'
    ? emailFleetStatus(runsDir, now, readers?.email ?? {})
    : telegramFleetStatus({ runsDir, now, ...readers?.telegram });
}

export interface DailyBriefPlanDeps {
  now?: () => Date;
  /** Stamp contents; the CLI reads them with readDailyBriefStamp. */
  lastSent?: DailyBriefLastSent;
  /** Channels to plan; default both. */
  channels?: readonly DailyBriefChannel[];
  /** Test seams — production defaults read the real config and composers. */
  isConfigured?: (channel: DailyBriefChannel) => boolean | Promise<boolean>;
  composeStatus?: (channel: DailyBriefChannel) => Promise<string>;
  needsYou?: () => number | null;
  /** Reader overrides forwarded to the default status composers. */
  readers?: { email?: EmailFleetStatusReaders; telegram?: TelegramFleetStatusDeps };
}

export async function planDailyBrief(opts: { runsDir: string } & DailyBriefPlanDeps): Promise<DailyBriefPlan> {
  const now = opts.now ?? (() => new Date());
  const day = dailyBriefLocalDay(now());
  const needs = opts.needsYou ? opts.needsYou() : defaultNeedsYou(opts.runsDir);
  const entries: DailyBriefPlanEntry[] = [];
  for (const channel of opts.channels ?? DAILY_BRIEF_CHANNELS) {
    if (opts.lastSent?.[channel] === day) {
      entries.push({ channel, send: false, reason: 'already-sent-today' });
      continue;
    }
    const configured = await (opts.isConfigured ?? ((c: DailyBriefChannel) => defaultIsConfigured(opts.runsDir, c)))(channel);
    if (!configured) {
      entries.push({ channel, send: false, reason: 'not-configured' });
      continue;
    }
    try {
      const status = await (opts.composeStatus ?? ((c: DailyBriefChannel) => defaultComposeStatus(opts.runsDir, c, now, opts.readers)))(channel);
      entries.push({ channel, send: true, text: dailyBriefText(needs, status) });
    } catch {
      entries.push({ channel, send: false, reason: 'status-unavailable' });
    }
  }
  return { day, entries };
}

/**
 * The email "send": queue a `*.reply.eml` in the drop outbox, exactly like
 * createEmailNoticeSender. Delivery stays with the outbox pass; queueing the
 * file is the send this verb dedupes. Throws when the drop config cannot name
 * exactly one recipient so the stamp is not written and the run retries.
 */
export function createDailyBriefEmailSender(runsDir: string, day: string): DailyBriefSender {
  return async (text) => {
    const { state, config } = await readEmailDropConfig(runsDir);
    if (state !== 'ok' || !config || config.from.length !== 1) {
      throw new Error('email-drop config needs exactly one allowed sender');
    }
    const outbox = config.outboxDir ?? join(config.inboxDir, '..', 'outbox');
    ensurePrivateDirectory(outbox);
    const name = `daily-brief-${day}.reply.eml`;
    const tmp = join(outbox, `.${name}.${process.pid}.tmp`);
    const body = text.replace(/\r?\n/g, '\r\n');
    try {
      writeFileSync(tmp, `To: ${config.from[0]}\r\nSubject: Phantom daily brief ${day}\r\n\r\n${body}\r\n`, { mode: 0o600 });
      renameSync(tmp, join(outbox, name));
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  };
}

/** The Telegram "send": sendTelegramMessage never throws, so !ok becomes one. */
export function createDailyBriefTelegramSender(cfg: AshlrConfig): DailyBriefSender {
  return async (text) => {
    const result = await sendTelegramMessage(text, undefined, cfg);
    if (!result.ok) throw new Error('telegram send failed');
  };
}

/** Production senders; a missing/!configured channel is simply absent. */
export async function defaultDailyBriefSenders(runsDir: string, day: string): Promise<DailyBriefSenders> {
  const senders: DailyBriefSenders = {};
  if (await defaultIsConfigured(runsDir, 'email')) senders.email = createDailyBriefEmailSender(runsDir, day);
  try {
    const cfg = loadConfigReadOnly();
    if (telegramEnabled(cfg)) senders.telegram = createDailyBriefTelegramSender(cfg);
  } catch { /* no telegram sender */ }
  return senders;
}

/**
 * Send a plan under the stamp lock: the stamp is re-read inside the lock so
 * an overlapping run's success is honored, each sendable channel gets one
 * send, and only successes are stamped — the same claim-then-record shape as
 * sendOrderMergeNotices. A busy lock skips every sendable channel rather
 * than racing a duplicate.
 */
export async function applyDailyBriefPlan(
  runsDir: string,
  plan: DailyBriefPlan,
  senders: DailyBriefSenders,
): Promise<DailyBriefApplied[]> {
  const stampPath = join(runsDir, DAILY_BRIEF_STAMP);
  const skipped = (entry: DailyBriefPlanEntry, reason?: string): DailyBriefApplied =>
    ({ channel: entry.channel, outcome: 'skipped', reason: reason ?? (entry.send ? undefined : entry.reason) });
  ensurePrivateDirectory(dirname(stampPath));
  const acquired = acquireLocalStoreLockWithOutcome(`${stampPath}.lock`, 0);
  if (acquired.state !== 'acquired') {
    return plan.entries.map(entry => skipped(entry, entry.send ? 'stamp-lock-busy' : undefined));
  }
  try {
    const stamp = readDailyBriefStamp(runsDir);
    const results: DailyBriefApplied[] = [];
    for (const entry of plan.entries) {
      if (!entry.send) { results.push(skipped(entry)); continue; }
      if (stamp[entry.channel] === plan.day) { results.push(skipped(entry, 'already-sent-today')); continue; }
      const send = senders[entry.channel];
      if (!send) { results.push(skipped(entry, 'no-sender')); continue; }
      try {
        await send(entry.text);
      } catch {
        results.push({ channel: entry.channel, outcome: 'failed' });
        continue;
      }
      stamp[entry.channel] = plan.day;
      writePrivateFileAtomic(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
      results.push({ channel: entry.channel, outcome: 'sent' });
    }
    return results;
  } finally {
    releaseLocalStoreLock(acquired.lock);
  }
}
