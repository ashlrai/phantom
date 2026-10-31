import { sinceText } from './connectivity.js';
import { deriveFleetNeedsYou } from '../shell/fleet-needs-you.js';

export interface FleetAttention {
  id: string;
  severity: 'high' | 'medium';
  title: string;
  detail: string;
  next: string;
  action?: { kind: 'screen'; screen: 'runs' | 'fleet' | 'leader'; label: string }
    | { kind: 'copy'; command: string; label: 'Copy command' };
}

export function attentionAction(open: unknown): FleetAttention['action'] {
  if (typeof open !== 'object' || open === null) return undefined;
  if ('kind' in open && open.kind === 'terminal' && 'command' in open && typeof open.command === 'string') {
    return { kind: 'copy', command: open.command, label: 'Copy command' };
  }
  if (!('kind' in open) || open.kind !== 'pane' || !('paneId' in open)) return undefined;
  switch (open.paneId) {
    case 'fleet-lanes': return { kind: 'screen', screen: 'runs', label: 'Open runs' };
    case 'fleet-supply':
    case 'fleet-host': return { kind: 'screen', screen: 'fleet', label: 'Open fleet' };
    case 'leader-journal': return { kind: 'screen', screen: 'leader', label: 'Open leader' };
    default: return undefined;
  }
}

/** Read-only issues from the latest fleet snapshot. */
export function fleetAttention(runs: unknown, nowMs: number): FleetAttention[] {
  if (runs === null) return [];
  const cards = new Map<string, FleetAttention>();
  for (const item of deriveFleetNeedsYou(runs, nowMs).items) {
    const action = attentionAction(item.open);
    if (!cards.has(item.id)) cards.set(item.id, {
      id: item.id, severity: item.severity === 'urgent' ? 'high' : 'medium',
      title: item.title, detail: item.detail, next: item.nextStep,
      ...(action ? { action } : {}),
    });
  }
  const lastTick = typeof runs === 'object' && runs !== null && 'lastTick' in runs ? runs.lastTick : undefined;
  const tick = typeof lastTick === 'string' ? Date.parse(lastTick) : NaN;
  if ((typeof lastTick === 'string' || lastTick === null) && (!Number.isFinite(tick) || nowMs - tick > 20 * 60_000)) {
    cards.set('orchestrator-tick', { id: 'orchestrator-tick', severity: 'high', title: 'Orchestrator tick stale',
      detail: Number.isFinite(tick) ? `Last tick: ${sinceText(tick, nowMs).replace(/^Updated /, '')}.` : 'Last tick: unknown.',
      next: 'On the Mac, check the orchestrator and its logs.' });
  }
  return [...cards.values()].sort((a, b) => (a.severity === b.severity ? a.title.localeCompare(b.title) : a.severity === 'high' ? -1 : 1));
}
