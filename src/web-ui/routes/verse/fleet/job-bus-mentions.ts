import { formatRelative } from '../autonomy/format.js';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';

export interface JobBusMention {
  key: string; at: string; from: string; to: string; kind: string; excerpt: string; ageText: string; expired: boolean;
}

export function jobBusMentions(receipts: readonly AgentBusReceipt[], job: string, nowMs: number, limit = 10): JobBusMention[] {
  const token = new RegExp(`(^|[^A-Za-z0-9_-])${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);
  const seen = new Set<string>();
  const rows: JobBusMention[] = [];
  for (const { receivedAt, envelope } of [...receipts].sort((a, b) => b.cursor - a.cursor)) {
    if (seen.has(envelope.id)) continue;
    seen.add(envelope.id);
    const body = typeof envelope.body === 'object' && envelope.body !== null && !Array.isArray(envelope.body)
      ? envelope.body as Record<string, unknown> : null;
    const json = JSON.stringify(envelope.body) ?? '';
    if (body?.job !== job && !token.test(json)) continue;
    const at = new Date(receivedAt).toISOString();
    const text = typeof body?.text === 'string' ? body.text : json;
    rows.push({ key: envelope.id, at, from: envelope.from, to: envelope.to,
      kind: typeof body?.kind === 'string' && body.kind ? body.kind : 'message',
      excerpt: text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 120),
      ageText: formatRelative(at, nowMs), expired: nowMs - receivedAt >= envelope.ttl });
    if (rows.length >= limit) break;
  }
  return limit > 0 ? rows : [];
}

export function mentionSummary(rows: readonly JobBusMention[], scannedCount: number): string {
  return `${rows.length ? `${rows.length} ${rows.length === 1 ? 'mention' : 'mentions'}` : 'No mentions'} in the last ${scannedCount} bus envelopes`;
}
