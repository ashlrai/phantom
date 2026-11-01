import { formatDateTime } from '../../../components/format/locale-format.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

export const CLAUDE_LANE_FIX_COMMAND = '~/.ashlr-runs/bin/fix-claude-lane.sh';
const SAFE_REASON = /^[\w .:()-]{1,160}$/;
const TIMESTAMP = /(?:^|\s)(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)(?:\s*)$/;

export function deriveClaudeLaneNeedsYou(runs: FleetRuns | null, nowMs: number): FleetNeedsYouItem[] {
  if (!runs?.claudeLane || !/^down/i.test(runs.claudeLane)) return [];
  const lane = runs.lanes.find(item => item.lane === 'claude');
  if (!lane || lane.target <= 0) return [];

  const status = runs.claudeLane.slice(4).trim().replace(/^:\s*/, '');
  const timestamp = TIMESTAMP.exec(status);
  const at = timestamp ? Date.parse(timestamp[1]!.replace(' ', 'T')) : NaN;
  const reason = (Number.isFinite(at) ? status.slice(0, timestamp!.index).trim() : status);
  const detail = [reason && SAFE_REASON.test(reason) ? reason : 'The lane reported itself down'];
  if (Number.isFinite(at) && Number.isFinite(nowMs)) {
    const local = formatDateTime(at, 'en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    detail.push(`since ${local}, ${Math.max(0, Math.floor((nowMs - at) / 3_600_000))} h ago`);
  }
  detail.push(`every hour idle is ${lane.target} worker-hours unused`);
  return [{
    id: 'claude-lane-down', severity: 'urgent', target: 'fleet',
    title: `Claude lane is down: ${Math.max(0, lane.target - lane.running)} slots idle`,
    detail: detail.join(' · '),
    nextStep: 'runs claude setup-token, saves the token silently; the fleet rechecks within 5 minutes',
    open: { kind: 'terminal', command: CLAUDE_LANE_FIX_COMMAND },
  }];
}
