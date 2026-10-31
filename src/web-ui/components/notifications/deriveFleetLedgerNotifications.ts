/**
 * components/notifications/deriveFleetLedgerNotifications.ts — the resource
 * ledger's per-lane dead signal, lifted into the bell.
 *
 * The Usage pane already badges a lane whose last finishes changed nothing,
 * but that badge only shows while the pane is on screen. A 'dead' lane means
 * dispatch is burning runs on work that produces nothing — an incident, so
 * it gets a store entry (and the desktop alert that comes with 'high').
 *
 * 'suspect' stays silent on purpose: the badge covers a signal that may still
 * be noise, and the bell should not cry before the ledger is sure. A 'held'
 * lane is skipped because deriveFleetRunsNotifications already notifies the
 * hold itself — two entries for one lane would duplicate the same story.
 */
import type { AppNotification, NotificationSeverity } from './types.js';
import { isResourceLedger } from '../../routes/verse/usage/fleet-ledger-model.js';
import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';

const scrub = (v: string) => v.replace(/[A-Za-z0-9_-]{32,}/g, '…');

/** Pure derivation: the stable per-lane id lets reconciliation retire a cleared signal. */
export function deriveFleetLedgerNotifications(data: unknown, _now: number): AppNotification[] {
  if (!isResourceLedger(data)) return [];
  const out: AppNotification[] = [];
  const base = typeof window === 'undefined' ? undefined : new URL('/verse/', window.location.href).toString();
  const add = (id: string, severity: NotificationSeverity, title: string, detail: string, target?: { label: string; pane: string }) => {
    const actionHref = target ? paneLinkUrl(target.pane, null, false, base) : null;
    out.push({ id, category: 'fleet', severity, title, detail, ts: data.generatedAt,
      ...(actionHref && target ? { actionLabel: target.label, actionHref } : {}) });
  };
  for (const lane of data.lanes) {
    const signal = lane.deadSignal;
    if (!signal || signal.state !== 'dead' || lane.held === true) continue;
    const detail = `${signal.emptyFailures} of the last ${signal.lastFinishes} finishes changed nothing.`
      + ((lane.running ?? 0) > 0 ? ' Dispatch keeps launching into it.' : '');
    add(`fleet-lane-dead-${lane.lane}`, 'high', `${scrub(lane.lane)} is producing empty results`, detail,
      { label: 'Open usage', pane: 'fleet-usage' });
  }
  return out;
}
