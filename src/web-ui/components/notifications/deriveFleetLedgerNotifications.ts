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
 *
 * The second signal is reset waste: a lane whose window closes soon with a
 * large share still unspent is capacity the fleet could have burned. Those
 * get a 'high' entry — the severity scale's warning tier — pointing at the
 * Usage pane, so unused quota shows up in the bell before the reset eats it.
 */
import type { AppNotification, NotificationSeverity } from './types.js';
import { isResourceLedger } from '../../routes/verse/usage/fleet-ledger-model.js';
import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';
import { projectResetWaste } from './reset-waste-model.js';

const scrub = (v: string) => v.replace(/[A-Za-z0-9_-]{32,}/g, '…');

const USAGE_PANE = { label: 'Open usage', pane: 'fleet-usage' } as const;

/** Pure derivation: the stable per-lane id lets reconciliation retire a cleared signal. */
export function deriveFleetLedgerNotifications(data: unknown, now: number): AppNotification[] {
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
    if (signal && signal.state === 'dead' && lane.held !== true) {
      const detail = `${signal.emptyFailures} of the last ${signal.lastFinishes} finishes changed nothing.`
        + ((lane.running ?? 0) > 0 ? ' Dispatch keeps launching into it.' : '');
      add(`fleet-lane-dead-${lane.lane}`, 'high', `${scrub(lane.lane)} is producing empty results`, detail,
        USAGE_PANE);
    }
    if (lane.held === true && lane.usedPct === null) continue;
    const waste = projectResetWaste(lane, now);
    if (waste.state !== 'wasting' || waste.unusedPct === null
      || waste.projectedUnusedPct === null || waste.hoursToReset === null) continue;
    const hours = waste.hoursToReset < 1 ? '<1' : `${Math.round(waste.hoursToReset)}`;
    const parts = [`~${Math.round(waste.projectedUnusedPct)}% still unused at reset`];
    if (waste.idleSlots !== null && waste.idleSlots > 0) parts.push(`${waste.idleSlots} idle slots`);
    if (lane.held === true) parts.push('lane held');
    add(`ledger-waste-${lane.lane}`, 'high',
      `${scrub(lane.lane)}: ${Math.round(waste.unusedPct)}% unused, resets in ${hours}h`,
      `${parts.join(' · ')}.`, USAGE_PANE);
  }
  return out;
}
