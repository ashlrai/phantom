import type { AgentBusReceipt, AgentBusStatus } from '../fleet-bus/agent-bus-queries.js';

type Tone = 'ok' | 'warn' | 'bad' | 'unknown';
const number = (value: number | null) => value === null ? '—' : String(value);
const bytes = (value: number | null) => value === null ? '—' : value >= 1024 * 1024
  ? `${Math.round(value / (1024 * 1024)).toLocaleString()} MB`
  : `${Math.round(value / 1024).toLocaleString()} KB`;

export function busTile(status: AgentBusStatus | null, receipts: readonly AgentBusReceipt[] | null, nowMs: number): {
  title: 'Bus'; reading: string; caption: string; tone: Tone;
} {
  if (!status) return { title: 'Bus', reading: 'Reading durable bus…', caption: 'Store status unknown', tone: 'unknown' };
  const caption = `Store ${status.source === 'available' ? 'available' : 'unavailable'} · ${number(status.retainedCount)} of ${number(status.maxMessages)} · ${bytes(status.retainedBytes)} of ${bytes(status.maxBytes)}`;
  const tone: Tone = status.source !== 'available' ? 'bad'
    : (status.retainedCount !== null && status.maxMessages > 0 && status.retainedCount / status.maxMessages >= 0.9)
      || (status.retainedBytes !== null && status.maxBytes > 0 && status.retainedBytes / status.maxBytes >= 0.9) ? 'warn'
      : status.retainedCount === null || status.retainedBytes === null ? 'unknown' : 'ok';
  if (!receipts) return { title: 'Bus', reading: 'Envelope count unavailable', caption, tone };
  const recent = receipts.filter(({ receivedAt }) => receivedAt >= nowMs - 3_600_000 && receivedAt <= nowMs);
  const forYou = recent.filter(({ envelope }) => envelope.to.toLowerCase() === 'mason').length;
  const cap = status.retainedCount !== null && status.retainedCount > 100 ? ' (of the last 100)' : '';
  return { title: 'Bus', reading: `${recent.length} ${recent.length === 1 ? 'envelope' : 'envelopes'} in the last hour${cap} · ${forYou} for you`, caption, tone };
}
