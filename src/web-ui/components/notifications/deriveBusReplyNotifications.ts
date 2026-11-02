import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';
import { envelopeRows } from '../../routes/verse/fleet-bus/agent-bus-model.js';
import type { AgentBusPage } from '../../routes/verse/fleet-bus/agent-bus-queries.js';
import type { AppNotification } from './types.js';

/** Project recent replies to Mason from the same page the bus rail reads. */
export function deriveBusReplyNotifications(page: AgentBusPage | null, nowMs: number): AppNotification[] {
  if (!page) return [];
  const masonIds = new Set(page.messages.filter(({ envelope }) => envelope.from === 'mason').map(({ envelope }) => envelope.id));
  const replies = page.messages.filter(({ envelope }) => {
    const body = envelope.body;
    const replyTo = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).replyTo : null;
    return envelope.from !== 'mason' && (envelope.to === 'mason'
      || (typeof replyTo === 'string' && (replyTo.startsWith('mason-') || masonIds.has(replyTo))));
  });
  const base = typeof window === 'undefined' ? undefined : new URL('/verse/', window.location.href).toString();
  const actionHref = paneLinkUrl('fleet-bus', null, false, base) ?? undefined;
  const seen = new Set<string>();
  return envelopeRows(replies, nowMs).flatMap((row) => {
    if (row.expired || nowMs - Date.parse(row.at) > 24 * 60 * 60 * 1000 || seen.has(row.id)) return [];
    seen.add(row.id);
    return [{ id: `bus-reply:${row.id}`, category: 'fleet' as const, severity: 'info' as const,
      title: `${row.from} replied on the bus`, detail: row.excerpt.slice(0, 140), ts: row.at,
      actionLabel: 'Open bus', actionHref }];
  });
}
