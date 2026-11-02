import { formatDateTime } from '../../../components/format/locale-format.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { CLAUDE_LANE_FIX_COMMAND } from './claude-lane-needs-you.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';
import type { LaneStreaksRead } from './lane-streak-query.js';

export function deriveLaneStreakNeedsYou(read: LaneStreaksRead | undefined, runs: FleetRuns | null, _nowMs: number): FleetNeedsYouItem[] {
  if (read?.kind !== 'available') return [];
  return read.data.lanes.flatMap((lane): FleetNeedsYouItem[] => {
    if (lane.verdict !== 'burning' || lane.lane === 'claude' && /^down/i.test(runs?.claudeLane ?? '')) return [];
    const detail = ['nothing published'];
    if (lane.medianMinutes !== null) detail.push(`median ${lane.medianMinutes} min per job`);
    const at = lane.lastEmptyAt === null ? NaN : Date.parse(lane.lastEmptyAt);
    if (lane.lastEmptyJob && Number.isFinite(at)) {
      detail.push(`last ${lane.lastEmptyJob} at ${formatDateTime(at, 'en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`);
    }
    const queued = runs?.lanes.find(item => item.lane === lane.lane)?.queued;
    if (queued !== undefined) detail.push(`${queued} queued behind it`);
    const claude = lane.lane.startsWith('claude');
    return [{
      id: `lane-burning-${lane.lane}`, severity: 'urgent', target: 'fleet',
      title: `Lane ${lane.lane} is burning jobs: ${lane.empties} of ${lane.launches} launches ended empty in ${read.data.windowMinutes} min`,
      detail: detail.join(' · '),
      nextStep: claude
        ? `run the Claude lane fix, then release the lane${lane.medianMinutes === null ? '' : `; until then every launch burns about ${lane.medianMinutes} minutes`}`
        : "hold the lane and read the last empty job's worker log",
      open: claude ? { kind: 'terminal', command: CLAUDE_LANE_FIX_COMMAND } : { kind: 'pane', paneId: 'fleet-lanes' },
    }];
  });
}
