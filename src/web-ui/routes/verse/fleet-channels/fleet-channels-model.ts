import { seenCounts } from '../fleet-inbox/inbox-ack-model.js';
import type { AnnotatedEntry } from '../fleet-inbox/inbox-ack-model.js';

export const KNOWN_CHANNELS = ['telegram', 'desktop', 'page', 'terminal', 'email', 'fleet-say', 'mobile'] as const;
export type ChannelKey = typeof KNOWN_CHANNELS[number] | 'other';

const labels: Record<ChannelKey, string> = {
  telegram: 'Telegram', desktop: 'Desktop app', page: 'Phantom page', terminal: 'Terminal',
  email: 'Email', 'fleet-say': 'Fleet-say', mobile: 'Mobile', other: 'Other',
};

export function channelKey(source: string): ChannelKey {
  const value = source.toLowerCase();
  if (value.includes('telegram') || /\btg\b/.test(value)) return 'telegram';
  if (value.includes('page') || value.includes('7790')) return 'page';
  if (value.includes('mobile') || value.includes('remote') || value.includes('phone')) return 'mobile';
  if (value.includes('mail')) return 'email';
  if (value.includes('say')) return 'fleet-say';
  if (value.includes('terminal') || value.includes('cli')) return 'terminal';
  if (value.includes('desktop') || value.includes('app') || value.includes('palette') || value.includes('composer')) return 'desktop';
  return 'other';
}

export function channelLabel(key: ChannelKey): string { return labels[key]; }

/**
 * Verbatim usage lines from src/cli/comms.ts (EMAIL_DROP_USAGE, and the
 * setup-telegram spec entry). The browser bundle cannot import the CLI
 * module, so they are mirrored here — keep byte-identical.
 */
export const EMAIL_DROP_USAGE = 'usage: phm comms email-drop <inboxDir> --from <address> [--from <address> ...] [--outbox <dir>] [--processed <dir>] [--once | --watch <seconds>] [--json]';
export const SETUP_TELEGRAM_USAGE = 'usage: phm comms setup-telegram';

export interface ChannelSetupHint {
  /** Verbatim CLI usage line shown under the row. */
  command: string;
  /** `command` without the `usage: ` prefix — the runnable line the copy button puts on the clipboard. */
  runCommand: string;
  /** Muted line: where the drop folder is, where acks land. */
  detail: string;
  /** Noun phrase for the copy control's accessible name, e.g. 'the email drop command'. */
  copyWhat: string;
}

/**
 * For a channel that has never delivered (row.total === 0), the setup hint
 * that turns it on. Null once a single message has landed — silence then is
 * a freshness question, not a setup question — and for channels with nothing
 * to enable.
 */
export function channelSetupHint(channel: ChannelKey, row: ChannelRow): ChannelSetupHint | null {
  if (row.total > 0) return null;
  if (channel === 'email') return {
    command: EMAIL_DROP_USAGE,
    runCommand: EMAIL_DROP_USAGE.replace(/^usage: /, ''),
    detail: 'Drop .eml files into <inboxDir> — any folder your mail path fills; handled mail moves to <inboxDir>/../processed. Acks are written as reply .eml files to <inboxDir>/../outbox. --from is required: unlisted senders are refused.',
    copyWhat: 'the email drop command',
  };
  if (channel === 'telegram') return {
    command: SETUP_TELEGRAM_USAGE,
    runCommand: SETUP_TELEGRAM_USAGE.replace(/^usage: /, ''),
    detail: 'Prints the bot-token setup steps and discovers your chat id.',
    copyWhat: 'the Telegram setup command',
  };
  return null;
}

/** Per-channel ack rollup for the Channels pane: how many of Mason's messages still wait on a leader pass. */
export function ackByChannel(entries: readonly AnnotatedEntry[]): Map<ChannelKey, { waiting: number; seen: number; overdue: boolean }> {
  const groups = new Map<ChannelKey, AnnotatedEntry[]>();
  for (const entry of entries) {
    const key = channelKey(entry.source);
    const group = groups.get(key);
    if (group) group.push(entry); else groups.set(key, [entry]);
  }
  const result = new Map<ChannelKey, { waiting: number; seen: number; overdue: boolean }>();
  for (const [key, group] of groups) result.set(key, seenCounts(group));
  return result;
}

export interface ChannelRow {
  key: ChannelKey; label: string; lastAt: string | null; preview: string | null;
  lastHour: number; last24h: number; total: number; rawSources: string[];
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const emptyRow = (key: ChannelKey): ChannelRow => ({ key, label: channelLabel(key), lastAt: null, preview: null, lastHour: 0, last24h: 0, total: 0, rawSources: [] });

function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= 120) return line;
  const prefix = line.slice(0, 119);
  const boundary = line[119] === ' ' ? prefix.length : prefix.lastIndexOf(' ');
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

export function rollupChannels(raw: unknown, nowMs: number): { rows: ChannelRow[]; silent: string[]; sourceState: string | null; generatedAt: string | null } | null {
  const data = record(raw);
  if (!Array.isArray(data.inbox)) return null;
  const rows = new Map<ChannelKey, ChannelRow>(KNOWN_CHANNELS.map(key => [key, emptyRow(key)]));
  for (const rawEntry of data.inbox) {
    const entry = record(rawEntry);
    if (typeof entry.at !== 'string' || typeof entry.source !== 'string' || typeof entry.text !== 'string') continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) continue;
    const key = channelKey(entry.source);
    let row = rows.get(key);
    if (!row) { row = emptyRow(key); rows.set(key, row); }
    row.total++;
    if (!row.rawSources.includes(entry.source)) row.rawSources.push(entry.source);
    const age = nowMs - at;
    if (age >= 0 && age <= 3_600_000) row.lastHour++;
    if (age >= 0 && age <= 86_400_000) row.last24h++;
    if (row.lastAt === null || at > Date.parse(row.lastAt)) { row.lastAt = entry.at; row.preview = preview(entry.text); }
  }
  const silent = KNOWN_CHANNELS.filter(key => rows.get(key)!.total === 0).map(channelLabel);
  const sorted = [...rows.values()].sort((a, b) => {
    if (a.lastAt === null) return b.lastAt === null ? 0 : 1;
    if (b.lastAt === null) return -1;
    return Date.parse(b.lastAt) - Date.parse(a.lastAt);
  });
  const sources = record(data.sources);
  return { rows: sorted, silent, sourceState: typeof sources.inbox === 'string' ? sources.inbox : null, generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null };
}
