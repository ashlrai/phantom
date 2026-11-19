import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { appActionEntry, type AppActionRow } from '../fleet-bus/app-action-envelope.js';
import type { MergedLine } from './thread-merge-model.js';

export interface BusReply {
  key: string;
  at: string;
  from: string;
  kind: string;
  excerpt: string;
  replyTo?: string;
  expired: boolean;
}

export function busRepliesToMason(receipts: readonly AgentBusReceipt[], nowMs: number, outbox: readonly { text: string }[] = []): BusReply[] {
  const seen = new Set<string>();
  const recordedReplies = new Set(outbox.map(entry => entry.text.trim()));
  return [...receipts].sort((a, b) => b.receivedAt - a.receivedAt || b.cursor - a.cursor).flatMap(({ receivedAt, envelope }) => {
    // App actions are receipts, not replies: the thread draws them as their own rows (AppActionLine).
    if (envelope.to.toLowerCase() !== 'mason' || seen.has(envelope.id) || appActionEntry(envelope)) return [];
    seen.add(envelope.id);
    const body = envelope.body !== null && typeof envelope.body === 'object' && !Array.isArray(envelope.body)
      ? envelope.body as Record<string, unknown> : null;
    const text = typeof body?.text === 'string' ? body.text : JSON.stringify(envelope.body);
    // The CEO bridge records the full reply in OUTBOX before mirroring it to
    // the bus. Prefer that durable full-text line, while retaining a bus-only
    // fallback when the record could not be read or falls outside its tail.
    if (envelope.from === 'leader' && 'origin_bridge' in envelope && envelope.origin_bridge === 'leader-network' &&
      (body?.kind === 'leader-reply' || body?.kind === 'leader-away-digest') && typeof body.text === 'string' && recordedReplies.has(body.text.trim())) return [];
    return [{ key: `bus-${envelope.id}`, at: new Date(receivedAt).toISOString(), from: envelope.from,
      kind: typeof body?.kind === 'string' ? body.kind : 'message',
      // eslint-disable-next-line no-control-regex -- reject control bytes in untrusted text.
      excerpt: (text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 120),
      ...(typeof body?.replyTo === 'string' ? { replyTo: body.replyTo } : {}),
      expired: nowMs - receivedAt >= envelope.ttl }];
  }).reverse();
}

export type ConversationItem = { type: 'line'; line: MergedLine } | { type: 'bus'; row: BusReply } | { type: 'app'; row: AppActionRow };

/** Preserve the existing thread order, including ties and undated lines; bus replies and app actions slot in by time. */
export function mergeByTime(threadItems: readonly MergedLine[], busRows: readonly BusReply[], appRows: readonly AppActionRow[] = []): ConversationItem[] {
  const extras = [
    ...busRows.map(row => ({ at: Date.parse(row.at), item: { type: 'bus', row } as ConversationItem })),
    ...appRows.map(row => ({ at: Date.parse(row.at), item: { type: 'app', row } as ConversationItem })),
  ].sort((a, b) => a.at - b.at);
  const result: ConversationItem[] = [];
  let next = 0;
  for (const line of threadItems) {
    while (next < extras.length && (!Number.isFinite(line.at) || extras[next]!.at < line.at)) result.push(extras[next++]!.item);
    result.push({ type: 'line', line });
  }
  while (next < extras.length) result.push(extras[next++]!.item);
  return result;
}

export function countNewReplies(rows: readonly BusReply[], sinceMs: number): number {
  return rows.filter(row => Date.parse(row.at) > sinceMs).length;
}
