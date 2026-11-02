/**
 * components/notifications/deriveMeterWatchNotifications.ts — lifts the
 * meter watch's 'stuck' lanes into the bell.
 *
 * The brief asks for 'warn' severity; the notification scale has no 'warn',
 * and 'high' is its warning band (severityToTone maps it to 'warning') —
 * the same severity the dead-lane incident uses, and the band that reaches
 * the desktop notification throttle, which an unmoving meter on a busy lane
 * deserves. 'unknown' stays silent on purpose: a short history is the normal
 * state after a reload, and the bell should not report it as news.
 *
 * The stable per-lane id lets reconciliation retire the entry on its own the
 * moment the meter moves (or the lane goes idle/held), with no resolved-spam.
 */
import type { AppNotification } from './types.js';
import { isResourceLedger } from '../../routes/verse/usage/fleet-ledger-model.js';
import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';
import { meterStalls, type MeterWatchLog } from './meter-watch-model.js';

const scrub = (v: string) => v.replace(/[A-Za-z0-9_-]{32,}/g, '…');

export function deriveMeterWatchNotifications(log: MeterWatchLog, data: unknown, now: number): AppNotification[] {
  if (!isResourceLedger(data)) return [];
  const running = new Map(data.lanes.map((row) => [row.lane, row.running ?? 0] as const));
  const out: AppNotification[] = [];
  const base = typeof window === 'undefined' ? undefined : new URL('/verse/', window.location.href).toString();
  for (const stall of meterStalls(log, data, now)) {
    if (stall.state !== 'stuck' || stall.stuckMinutes === null) continue;
    const actionHref = paneLinkUrl('fleet-usage', null, false, base);
    out.push({
      id: `meter-stuck-${stall.lane}`,
      category: 'fleet',
      severity: 'high',
      title: `${scrub(stall.lane)} meter has not moved in ${stall.stuckMinutes} min while ${running.get(stall.lane) ?? 0} run`,
      detail: "Treat as an incident: check the lane's sessions and the ledger source",
      ts: data.generatedAt,
      ...(actionHref ? { actionLabel: 'Open usage', actionHref } : {}),
    });
  }
  return out;
}
