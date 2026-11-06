import { formatDateTime } from '../../../components/format/locale-format.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';
import type { MainHealthRead } from './main-health-query.js';

function displayTime(value: string | null): string {
  const at = value === null ? NaN : Date.parse(value);
  return Number.isFinite(at)
    ? formatDateTime(at, 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    : 'unknown time';
}

export function deriveMainHealthNeedsYou(read: MainHealthRead | undefined): FleetNeedsYouItem[] {
  if (read?.kind !== 'available') return [];
  const { repos, guardianOff, stale, statusAt } = read.data;
  const items: FleetNeedsYouItem[] = repos.flatMap(repo => repo.state === 'red' && repo.fixJobs.length === 0 ? [{
    id: `main-red-${repo.repo}`, severity: 'urgent' as const, target: 'fleet' as const,
    title: `${repo.repo} ${repo.branch} is red with no fix job: ${repo.failingCheck || 'unknown check'}`,
    detail: `${repo.sha ? repo.sha.slice(0, 7) : 'unknown SHA'} · checked ${displayTime(repo.checkedAt)}`,
    nextStep: 'Read ~/.ashlr-runs/guardian/guardian.log',
    open: { kind: 'pane' as const, paneId: 'fleet-lanes' },
  }] : []);
  if (guardianOff) {
    items.push({ id: 'main-guardian-off', severity: 'attention', target: 'fleet',
      title: 'The main guardian is switched off', detail: 'The main guardian kill switch is on.',
      nextStep: 'Turn off MAIN_GUARDIAN_OFF in Fleet ▸ Switches if the stop was not meant',
      open: { kind: 'pane', paneId: 'fleet-lanes' } });
  } else if (stale) {
    items.push({ id: 'main-guardian-stale', severity: 'attention', target: 'fleet',
      title: statusAt === null ? 'The main guardian has no status file' : `The main guardian has not written since ${displayTime(statusAt)}`,
      detail: 'The guardian status is stale.', nextStep: 'Check launchd label ai.ashlr.main-guardian',
      open: { kind: 'pane', paneId: 'fleet-lanes' } });
  }
  return items;
}
