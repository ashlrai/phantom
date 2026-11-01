import { formatRelative } from '../autonomy/format.js';
import type { AgentBusReceipt, AgentBusStatus } from './agent-bus-queries.js';

const channels = ['email', 'telegram', 'mobile', 'desktop', 'page', 'cli'] as const;
type Channel = typeof channels[number];
export interface EnvelopeRow {
  cursor: number; id: string; from: string; to: string; priority: AgentBusReceipt['envelope']['priority'];
  at: string; ageText: string; kind: string; channel: Channel | null; excerpt: string; expired: boolean;
}
export function envelopeRows(messages: readonly AgentBusReceipt[], nowMs: number): EnvelopeRow[] {
  return messages.map(({ cursor, receivedAt, envelope }) => {
    const body = typeof envelope.body === 'object' && envelope.body !== null && !Array.isArray(envelope.body)
      ? envelope.body as Record<string, unknown> : null;
    const kind = typeof body?.kind === 'string' && body.kind.length > 0 && body.kind.length <= 64 ? body.kind : 'message';
    const channel = typeof body?.channel === 'string' && channels.some(value => value === body.channel) ? body.channel as Channel : null;
    const text = typeof body?.text === 'string' ? body.text : JSON.stringify(envelope.body);
    const at = new Date(receivedAt).toISOString();
    return { cursor, id: envelope.id, from: envelope.from, to: envelope.to, priority: envelope.priority, at,
      ageText: formatRelative(at, nowMs), kind, channel,
      excerpt: (text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 200),
      expired: nowMs - receivedAt >= envelope.ttl };
  }).sort((a, b) => b.cursor - a.cursor);
}
export const isMasonInterjection = (row: EnvelopeRow) => row.kind === 'interjection' && row.from === 'mason';
export function busStatusLine(status: AgentBusStatus): string {
  if (status.source === 'missing') return 'durable bus storage missing';
  const number = (value: number | null) => value === null ? '—' : value.toLocaleString();
  const bytes = status.retainedBytes === null ? '—' : `${Math.round(status.retainedBytes / 1024).toLocaleString()} KB`;
  return `${number(status.retainedCount)} retained · ${number(status.liveCount)} live · ${number(status.expiredCount)} expired · ${bytes}`;
}
