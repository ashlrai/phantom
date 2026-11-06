import type { FleetNeedsYouItem, FleetNeedsYouResult } from './fleet-needs-you.js';
import type { UsageResets } from './usage-resets-query.js';

export function deriveResetNeedsYou(resets: UsageResets | null | undefined, _nowMs: number): FleetNeedsYouItem[] {
  return (resets?.rows ?? []).filter(row => row.releasable && row.heldBy === 'autobackoff' &&
    (row.state === 'reset-detected' || row.state === 'hold-expired')).map(row => ({
    id: `lane-reset:${row.lane}`, severity: 'urgent',
    title: row.state === 'hold-expired' ? `${row.lane} hold expired; still marked held` : `${row.lane} reset; its hold is still on`,
    detail: row.tell, nextStep: 'Release it here, or in Fleet ▸ Lanes', target: 'fleet',
    open: { kind: 'pane', paneId: 'fleet-lanes' },
  }));
}

export function mergeNeedsYou(base: FleetNeedsYouResult, resetItems: FleetNeedsYouItem[]): FleetNeedsYouResult {
  const lanes = new Set(resetItems.map(item => item.id.slice('lane-reset:'.length)));
  return { ...base, items: [...base.items.filter(item =>
    !(item.id === 'supply-personal-reset' && lanes.has('codex-personal')) &&
    !(item.id.startsWith('lane-held:') && lanes.has(item.id.slice('lane-held:'.length)))), ...resetItems] };
}
