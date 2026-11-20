import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';
import { envelopeRows } from '../../routes/verse/fleet-bus/agent-bus-model.js';
import { appActionEntry, appActionNeedsAttention, appActionStateWord, appActionTitle, appActionWaitsOnYou } from '../../routes/verse/fleet-bus/app-action-envelope.js';
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
  const threadHref = paneLinkUrl('leader-thread', null, false, base) ?? undefined;
  const apps = new Map(replies.flatMap(({ envelope }) => { const entry = appActionEntry(envelope); return entry ? [[envelope.id, entry] as const] : []; }));
  const seen = new Set<string>();
  return envelopeRows(replies, nowMs).flatMap((row): AppNotification[] => {
    if (row.expired || nowMs - Date.parse(row.at) > 24 * 60 * 60 * 1000 || seen.has(row.id)) return [];
    seen.add(row.id);
    // An app action is a receipt, not a reply: its start and a clean result stay in the Leader thread,
    // and only one that did not happen (or whose result is unknown) interrupts, in plain words.
    const app = apps.get(row.id);
    if (app) {
      const state = app.outcome;
      if (state === null || !appActionNeedsAttention(state)) return [];
      return [{ id: `app-action:${row.id}`, category: 'fleet' as const, severity: appActionWaitsOnYou(state) ? 'high' as const : 'low' as const,
        title: `${appActionTitle(app)}: ${appActionStateWord(state)}`, detail: app.detail.slice(0, 140), ts: row.at,
        actionLabel: 'Open Leader', actionHref: threadHref }];
    }
    return [{ id: `bus-reply:${row.id}`, category: 'fleet' as const, severity: 'info' as const,
      title: `${row.from} replied on the bus`, detail: row.excerpt.slice(0, 140), ts: row.at,
      actionLabel: 'Open bus', actionHref }];
  });
}
