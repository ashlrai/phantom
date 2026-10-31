import type { ReleasePrResult } from '../fleet/release-pr-query.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

function openAge(openedAt: string, nowMs: number): string {
  const at = Date.parse(openedAt);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return 'open since unknown';
  const seconds = Math.max(0, Math.round((nowMs - at) / 1_000));
  if (seconds < 60) return `open ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `open ${minutes} m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `open ${hours} h`;
  return `open ${Math.round(hours / 24)} d`;
}

export function deriveReleaseNeedsYou(result: ReleasePrResult | undefined, nowMs: number): FleetNeedsYouItem[] {
  if (!result || result.kind === 'notInBuild') return [];
  return result.data.repos.flatMap(({ repo, pr }) => {
    if (!pr?.blocked) return [];
    const failed = pr.checks.filter(check => check.state === 'fail').map(check => check.name);
    const names = pr.failing.length > 0 ? pr.failing : failed;
    const reason = names.length > 0 ? `${names.slice(0, 3).join(', ')} failing`
      : pr.pending > 0 ? `${pr.pending} ${pr.pending === 1 ? 'check' : 'checks'} pending`
        : pr.mergeable?.toLowerCase() === 'conflicting' ? 'Merge conflict' : 'Merge blocked';
    return [{
      id: `release-blocked:${repo}:${pr.number}`,
      severity: failed.length > 0 ? 'urgent' : 'attention',
      title: `Release ${pr.version || pr.title} is blocked`,
      detail: `${reason} · ${openAge(pr.openedAt, nowMs)}`,
      nextStep: 'Open the release PR; Merge Gate reruns after the fix lands',
      target: 'fleet',
    }];
  });
}
