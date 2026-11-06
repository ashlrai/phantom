/**
 * RQ-PHX-DAILYBRIEFSEND04: one short fleet summary per channel per slot, on a
 * local-day budget — `ashlr fleet brief-send` dry-runs, `--apply` sends.
 * RQ-COS-BRIEF-1 adds two slots per day: 'morning' (7:30 ET) and 'overnight'
 * (22:30 ET), times configurable (ASHLR_BRIEF_MORNING_AT / _OVERNIGHT_AT as
 * 'HH:MM', or the slotTimes seam). Each slot keeps its own local-day stamp, so
 * a channel gets at most one morning and one overnight brief per day. With no
 * explicit slot the latest slot whose time has passed today is used; before
 * the morning time nothing is due ('slot-not-due'). The text opens with a
 * needs-you list of at most DAILY_BRIEF_NEEDS_MAX items (automation review
 * items, then pending drafts when a drafts source is supplied; no source means
 * the drafts section is skipped cleanly).
 *
 *   planDailyBrief({ runsDir, now, lastSent }) — for each channel ('email',
 *     'telegram') yields { send: true, text } or { send: false, reason }.
 *     Text is the existing status composer output (email-fleet-status /
 *     telegram-fleet-status) led by the needs-you count, bounded to
 *     DAILY_BRIEF_MAX_CHARS of plain text. Skip reasons:
 *     'already-sent-today', 'not-configured', 'status-unavailable'.
 *   queue/daily-brief-last.json — the stamp: { email?: 'YYYY-MM-DD',
 *     telegram?: 'YYYY-MM-DD' } in America/New_York local date. Those keys are
 *     the morning slot; the overnight slot uses emailOvernight / telegramOvernight. A channel
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
import { needsYouItems, refreshAutomationsNeedsYou } from '../automations/needs-you.js';
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
export const DAILY_BRIEF_SLOTS = ['morning', 'overnight'] as const;
export type DailyBriefSlot = (typeof DAILY_BRIEF_SLOTS)[number];
export const DAILY_BRIEF_MAX_CHARS = 1200;
export const DAILY_BRIEF_NEEDS_MAX = 5;
/** Default slot times, America/New_York 'HH:MM'. */
export const DAILY_BRIEF_SLOT_TIMES: Readonly<Record<DailyBriefSlot, string>> = { morning: '07:30', overnight: '22:30' };
const SLOT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DAILY_BRIEF_STAMP = join('queue', 'daily-brief-last.json');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Per-channel last-sent local dates (America/New_York 'YYYY-MM-DD'). */
export interface DailyBriefLastSent {
  email?: string;
  telegram?: string;
  emailOvernight?: string;
  telegramOvernight?: string;
}
type StampKey = keyof DailyBriefLastSent;
const STAMP_KEYS: readonly StampKey[] = ['email', 'telegram', 'emailOvernight', 'telegramOvernight'];

/** Morning keeps the legacy per-channel keys so existing stamps stay valid. */
export function dailyBriefStampKey(channel: DailyBriefChannel, slot: DailyBriefSlot): StampKey {
  return slot === 'morning' ? channel : channel === 'email' ? 'emailOvernight' : 'telegramOvernight';
}

export type DailyBriefSkipReason = 'already-sent-today' | 'not-configured' | 'status-unavailable' | 'slot-not-due';
export type DailyBriefPlanEntry =
  | { channel: DailyBriefChannel; send: true; text: string }
  | { channel: DailyBriefChannel; send: false; reason: DailyBriefSkipReason };

export interface DailyBriefPlan {
  slot: DailyBriefSlot;
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

/** Minutes since local midnight in the operator's zone. */
function localMinutes(at: Date, timeZone = 'America/New_York'): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const p = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? '0');
    return p('hour') * 60 + p('minute');
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Env and override values that are not 'HH:MM' fall back to the defaults. */
export function resolveDailyBriefSlotTimes(
  override: Partial<Record<DailyBriefSlot, string>> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<DailyBriefSlot, string> {
  const pick = (slot: DailyBriefSlot, fromEnv: string | undefined): string => {
    for (const candidate of [override[slot], fromEnv]) if (candidate && SLOT_TIME.test(candidate)) return candidate;
    return DAILY_BRIEF_SLOT_TIMES[slot];
  };
  return { morning: pick('morning', env.ASHLR_BRIEF_MORNING_AT), overnight: pick('overnight', env.ASHLR_BRIEF_OVERNIGHT_AT) };
}

/** The latest slot whose time has passed today, or null before the first one. */
export function dueDailyBriefSlot(at: Date, times: Record<DailyBriefSlot, string>): DailyBriefSlot | null {
  const minutes = localMinutes(at);
  return DAILY_BRIEF_SLOTS
    .filter(slot => toMinutes(times[slot]) <= minutes)
    .sort((a, b) => toMinutes(times[b]) - toMinutes(times[a]))[0] ?? null;
}

/**
 * Needs-you count first, then up to DAILY_BRIEF_NEEDS_MAX list lines, then the
 * allowlisted composer text, all within 1200 chars. The overnight slot is
 * labelled on the head line; morning stays unlabelled for back-compat.
 */
export function dailyBriefText(needs: number | null, status: string, list: readonly string[] = [], slot: DailyBriefSlot = 'morning'): string {
  const count = needs === null || !Number.isSafeInteger(needs) || needs < 0 ? 'unavailable' : needs;
  const lines = list.slice(0, DAILY_BRIEF_NEEDS_MAX).map(line => scrubSecrets(String(line)).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const head = [`Needs you: ${count}${slot === 'overnight' ? ' (overnight)' : ''}`, ...lines.map(line => `- ${line}`)].join('\n');
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
  for (const key of STAMP_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && DAY.test(value)) stamp[key] = value;
  }
  return stamp;
}

/** Needs-you as a total plus the lines to list: the owner ledger, then automation reviews, then drafts. */
export interface DailyBriefNeeds {
  total: number | null;
  lines: string[];
}

/**
 * Pending drafts source (RQ-COS-DRAFTS-1). That lane has not merged, so there
 * is no default reader: callers that have one pass it via planDeps.drafts and
 * the section is skipped cleanly otherwise.
 */
export type DailyBriefDraftsSource = () => string[] | Promise<string[]>;

async function defaultNeeds(runsDir: string, drafts?: DailyBriefDraftsSource): Promise<DailyBriefNeeds> {
  let total: number | null = null;
  const lines: string[] = [];
  try {
    const result = readNeedsMason({ runsDir });
    if (result.status !== 'unavailable') {
      total = result.items.length;
      for (const item of result.items) lines.push(item.text);
    }
  } catch { /* ledger unavailable: total stays null */ }
  try {
    await refreshAutomationsNeedsYou();
    const items = needsYouItems();
    if (total !== null) total += items.length;
    for (const item of items) lines.push(item.title);
  } catch { /* automation items are best effort */ }
  if (drafts) {
    try {
      const pending = await drafts();
      if (total !== null) total += pending.length;
      for (const draft of pending) lines.push(`Draft to approve: ${draft}`);
    } catch { /* drafts section skipped */ }
  }
  return { total, lines };
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
  /** Slot to plan; default is the latest slot due now (null before the first). */
  slot?: DailyBriefSlot;
  /** 'HH:MM' overrides for the slot times; env and defaults fill the rest. */
  slotTimes?: Partial<Record<DailyBriefSlot, string>>;
  /** Pending draft titles to list under needs-you; absent skips the section. */
  drafts?: DailyBriefDraftsSource;
  /** Test seams — production defaults read the real config and composers. */
  isConfigured?: (channel: DailyBriefChannel) => boolean | Promise<boolean>;
  composeStatus?: (channel: DailyBriefChannel) => Promise<string>;
  needsYou?: () => number | null | DailyBriefNeeds | Promise<number | null | DailyBriefNeeds>;
  /** Reader overrides forwarded to the default status composers. */
  readers?: { email?: EmailFleetStatusReaders; telegram?: TelegramFleetStatusDeps };
}

export async function planDailyBrief(opts: { runsDir: string } & DailyBriefPlanDeps): Promise<DailyBriefPlan> {
  const now = opts.now ?? (() => new Date());
  const day = dailyBriefLocalDay(now());
  const due = opts.slot ?? dueDailyBriefSlot(now(), resolveDailyBriefSlotTimes(opts.slotTimes));
  const slot: DailyBriefSlot = due ?? 'morning';
  const entries: DailyBriefPlanEntry[] = [];
  if (!due) {
    for (const channel of opts.channels ?? DAILY_BRIEF_CHANNELS) entries.push({ channel, send: false, reason: 'slot-not-due' });
    return { slot, day, entries };
  }
  const raw = opts.needsYou ? await opts.needsYou() : await defaultNeeds(opts.runsDir, opts.drafts);
  const needs: DailyBriefNeeds = raw !== null && typeof raw === 'object' ? raw : { total: raw, lines: [] };
  for (const channel of opts.channels ?? DAILY_BRIEF_CHANNELS) {
    if (opts.lastSent?.[dailyBriefStampKey(channel, slot)] === day) {
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
      entries.push({ channel, send: true, text: dailyBriefText(needs.total, status, needs.lines, slot) });
    } catch {
      entries.push({ channel, send: false, reason: 'status-unavailable' });
    }
  }
  return { slot, day, entries };
}

/**
 * The email "send": queue a `*.reply.eml` in the drop outbox, exactly like
 * createEmailNoticeSender. Delivery stays with the outbox pass; queueing the
 * file is the send this verb dedupes. Throws when the drop config cannot name
 * exactly one recipient so the stamp is not written and the run retries.
 */
export function createDailyBriefEmailSender(runsDir: string, day: string, slot: DailyBriefSlot = 'morning'): DailyBriefSender {
  return async (text) => {
    const { state, config } = await readEmailDropConfig(runsDir);
    if (state !== 'ok' || !config || config.from.length !== 1) {
      throw new Error('email-drop config needs exactly one allowed sender');
    }
    const outbox = config.outboxDir ?? join(config.inboxDir, '..', 'outbox');
    ensurePrivateDirectory(outbox);
    const name = slot === 'morning' ? `daily-brief-${day}.reply.eml` : `daily-brief-${day}-${slot}.reply.eml`;
    const tmp = join(outbox, `.${name}.${process.pid}.tmp`);
    const body = text.replace(/\r?\n/g, '\r\n');
    try {
      writeFileSync(tmp, `To: ${config.from[0]}\r\nSubject: Phantom ${slot} brief ${day}\r\n\r\n${body}\r\n`, { mode: 0o600 });
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
export async function defaultDailyBriefSenders(runsDir: string, day: string, slot: DailyBriefSlot = 'morning'): Promise<DailyBriefSenders> {
  const senders: DailyBriefSenders = {};
  if (await defaultIsConfigured(runsDir, 'email')) senders.email = createDailyBriefEmailSender(runsDir, day, slot);
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
      const key = dailyBriefStampKey(entry.channel, plan.slot);
      if (stamp[key] === plan.day) { results.push(skipped(entry, 'already-sent-today')); continue; }
      const send = senders[entry.channel];
      if (!send) { results.push(skipped(entry, 'no-sender')); continue; }
      try {
        await send(entry.text);
      } catch {
        results.push({ channel: entry.channel, outcome: 'failed' });
        continue;
      }
      stamp[key] = plan.day;
      writePrivateFileAtomic(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
      results.push({ channel: entry.channel, outcome: 'sent' });
    }
    return results;
  } finally {
    releaseLocalStoreLock(acquired.lock);
  }
}
