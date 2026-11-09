/**
 * routes/verse/leader-thread/owner-thread-lines.ts — owner-thread messages as
 * the MergedLines the Leader thread already renders, channel kept for the
 * badge. Pure.
 */
import type { OwnerThreadLine } from './owner-thread-queries.js';
import type { MergedLine } from './thread-merge-model.js';

/** A MergedLine that names its speaker, e.g. "Mason via iMessage". */
export type LabeledLine = MergedLine & { label?: string };

const CHANNEL_NAME: Readonly<Record<string, string>> = { desktop: 'Desktop', telegram: 'Telegram', email: 'Email', imessage: 'iMessage', slack: 'Slack' };
export const channelName = (channel: string) => CHANNEL_NAME[channel] ?? channel;
const minute = (ms: number) => Math.floor(ms / 60_000);

/**
 * Inbound lines read "Mason via <channel>"; outbound read "Leader → <fanout>".
 * The server mirrors a desktop post into both the owner thread and
 * MASON-INBOX, so a desktop line matching an inbox line (text and minute) is dropped.
 */
export function ownerThreadLines(rows: readonly OwnerThreadLine[], fleetLines: readonly MergedLine[]): LabeledLine[] {
  const mirrored = new Set(fleetLines.filter(l => l.who === 'mason' && Number.isFinite(l.at)).map(l => `${minute(l.at)}|${l.text.trim()}`));
  return rows.flatMap((row): LabeledLine[] => {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) return [];
    const inbound = row.direction === 'inbound';
    if (inbound && row.channel === 'desktop' && mirrored.has(`${minute(at)}|${row.text.trim()}`)) return [];
    const targets = row.fanout?.length ? row.fanout : [row.channel];
    return [{ at, who: inbound ? 'mason' : 'leader', source: row.channel, text: row.text, id: `owner-${row.id}`, ack: null,
      label: inbound ? `Mason via ${channelName(row.channel)}` : `Leader → ${targets.map(channelName).join(', ')}` }];
  });
}

/** Dated fleet lines with owner lines folded in by time; ties keep the fleet line first. */
export function mergeOwnerLines(lines: readonly LabeledLine[], owner: readonly LabeledLine[]): LabeledLine[] {
  if (!owner.length) return lines as LabeledLine[];
  const sorted = [...owner].sort((a, b) => a.at - b.at);
  const out: LabeledLine[] = [];
  let next = 0;
  for (const line of lines) {
    while (next < sorted.length && Number.isFinite(line.at) && sorted[next]!.at < line.at) out.push(sorted[next++]!);
    out.push(line);
  }
  return [...out, ...sorted.slice(next)];
}
