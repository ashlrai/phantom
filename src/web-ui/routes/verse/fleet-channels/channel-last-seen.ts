/**
 * channel-last-seen.ts — per-channel presence for the Channels dock pane.
 * For every channel the pane lists: when Mason was last heard from there
 * (the shared ET wall-clock rule from interject-ack-model, not Date.parse)
 * and whether the newest leader pass has already read that message.
 */
import { newestLeaderPassMs, parseInboxAt } from '../fleet/interject-ack-model.js';
import { formatRelative } from '../autonomy/format.js';
import { channelKey } from './fleet-channels-model.js';

export interface ChannelPresence {
  channel: string;
  lastFromMasonMs: number | null;
  count24h: number;
  /** true: a leader pass ran after the latest message; false: leader is up but the pass predates it; null: nothing to read or no pass on record. */
  readByPass: boolean | null;
}

const DAY_MS = 86_400_000;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Inbox `at` is `YYYY-MM-DD HH:MM` ET; an ISO string is accepted as a fallback. */
function entryMs(at: string, nowMs: number): number | null {
  const wall = parseInboxAt(at, nowMs);
  if (wall !== null) return wall;
  const iso = Date.parse(at);
  return Number.isFinite(iso) ? iso : null;
}

/** Instant of the newest leader pass across the snapshot's leader rows, or null when no pass is on record. */
export function leaderPassMs(leaders: unknown, generatedAtIso: unknown): number | null {
  const generatedAtMs = typeof generatedAtIso === 'string' ? Date.parse(generatedAtIso) : NaN;
  const ages = Array.isArray(leaders) ? leaders.flatMap(value => {
    const ageSeconds = record(value).ageSeconds;
    return typeof ageSeconds === 'number' || ageSeconds === null ? [{ ageSeconds }] : [];
  }) : undefined;
  return newestLeaderPassMs(ages, generatedAtMs);
}

export function deriveChannelPresence(
  inbox: unknown,
  leaders: unknown,
  generatedAtIso: unknown,
  nowMs: number,
  knownChannels: readonly string[],
): ChannelPresence[] {
  const newestPassMs = leaderPassMs(leaders, generatedAtIso);
  const rows = new Map<string, { channel: string; lastFromMasonMs: number | null; count24h: number }>();
  const ensure = (channel: string) => {
    let row = rows.get(channel);
    if (!row) { row = { channel, lastFromMasonMs: null, count24h: 0 }; rows.set(channel, row); }
    return row;
  };
  for (const channel of knownChannels) ensure(channel);
  const seen = new Map<string, string>();
  for (const rawEntry of Array.isArray(inbox) ? inbox : []) {
    const entry = record(rawEntry);
    if (typeof entry.at !== 'string' || typeof entry.source !== 'string') continue;
    const ms = entryMs(entry.at, nowMs);
    if (ms === null) continue;
    const key = channelKey(entry.source);
    let channel: string = key;
    if (key === 'other') {
      const trimmed = entry.source.trim();
      if (!trimmed) continue;
      channel = seen.get(trimmed.toLowerCase()) ?? trimmed;
      seen.set(trimmed.toLowerCase(), channel);
    }
    const row = ensure(channel);
    row.lastFromMasonMs = row.lastFromMasonMs === null ? ms : Math.max(row.lastFromMasonMs, ms);
    const age = nowMs - ms;
    if (age >= 0 && age <= DAY_MS) row.count24h++;
  }
  return [...rows.values()].map(({ channel, lastFromMasonMs, count24h }) => ({
    channel, lastFromMasonMs, count24h,
    readByPass: lastFromMasonMs === null || newestPassMs === null ? null : newestPassMs > lastFromMasonMs,
  }));
}

/** Presence for one pane row; the 'other' row folds every channel outside `knownChannels`. */
export function presenceForChannel(
  presence: readonly ChannelPresence[],
  channel: string,
  knownChannels: readonly string[],
): ChannelPresence | undefined {
  if (channel !== 'other') return presence.find(row => row.channel === channel);
  const extras = presence.filter(row => !knownChannels.includes(row.channel));
  if (!extras.length) return undefined;
  const heard = extras.filter(row => row.lastFromMasonMs !== null);
  const newest = heard.reduce<ChannelPresence | undefined>((best, row) =>
    best === undefined || row.lastFromMasonMs! > best.lastFromMasonMs! ? row : best, undefined);
  return {
    channel: 'other',
    lastFromMasonMs: newest?.lastFromMasonMs ?? null,
    count24h: extras.reduce((sum, row) => sum + row.count24h, 0),
    readByPass: newest?.readByPass ?? null,
  };
}

const etClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** `HH:MM` ET wall time — the same clock the inbox stamps its entries on. */
export function passClockEt(ms: number): string {
  const parts = etClock.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')}`;
}

/** The one-line per-channel summary: "last from you 12m ago · read by the 07:15 pass", or "nothing yet". */
export function channelPresenceLine(presence: ChannelPresence | undefined, newestPassMs: number | null): string {
  if (presence === undefined || presence.lastFromMasonMs === null) return 'nothing yet';
  const read = presence.readByPass === true
    ? ` · read by the ${newestPassMs === null ? '' : `${passClockEt(newestPassMs)} `}pass`
    : presence.readByPass === false ? ' · waiting for a leader pass' : ' · no leader pass yet';
  return `last from you ${formatRelative(new Date(presence.lastFromMasonMs).toISOString())}${read}`;
}
