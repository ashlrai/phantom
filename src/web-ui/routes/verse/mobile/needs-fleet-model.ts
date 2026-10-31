import { sinceText } from './connectivity.js';
import type { FleetRuns } from './home-runs-model.js';

export interface FleetAttention {
  id: string;
  severity: 'high' | 'medium';
  title: string;
  detail: string;
  next: string;
}

/** Read-only issues from the latest fleet snapshot. */
export function fleetAttention(runs: FleetRuns | null, nowMs: number): FleetAttention[] {
  if (!runs) return [];
  const cards: FleetAttention[] = [];
  if (/^down/i.test(runs.claudeLane ?? '')) {
    cards.push({ id: 'claude-lane', severity: 'high', title: 'Claude lane down',
      detail: 'The Claude lane is down.', next: 'On the Mac run ~/.ashlr-runs/bin/fix-claude-lane.sh' });
  }
  for (const name of new Set(runs.switches)) {
    cards.push({ id: `switch:${name}`, severity: 'medium', title: `${name} is on`,
      detail: 'This fleet switch is active.', next: 'On the Mac, review the switch before turning it off.' });
  }
  for (const lane of runs.lanes) {
    if (lane.held) cards.push({ id: `lane:${lane.lane}`, severity: 'medium', title: `Lane ${lane.lane} held`,
      detail: 'This lane is held.', next: 'On the Mac, review the lane hold before resuming it.' });
  }
  const tick = runs.lastTick === null ? NaN : Date.parse(runs.lastTick);
  if (!Number.isFinite(tick) || nowMs - tick > 20 * 60_000) {
    cards.push({ id: 'orchestrator-tick', severity: 'high', title: 'Orchestrator tick stale',
      detail: Number.isFinite(tick) ? `Last tick: ${sinceText(tick, nowMs).replace(/^Updated /, '')}.` : 'Last tick: unknown.',
      next: 'On the Mac, check the orchestrator and its logs.' });
  }
  return cards.sort((a, b) => (a.severity === b.severity ? a.title.localeCompare(b.title) : a.severity === 'high' ? -1 : 1));
}
