import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';
import { isReleasePrData } from '../../routes/verse/fleet/release-pr-query.js';
import { deriveReleaseNeedsYou } from '../../routes/verse/shell/release-needs-you.js';
import type { AppNotification } from './types.js';

const scrub = (value: string) => value.replace(/[A-Za-z0-9_-]{32,}/g, '…');

/** Share the drawer's blocking reason and severity while keeping incident ids stable. */
export function deriveReleasePrNotifications(result: unknown, nowMs: number): AppNotification[] {
  if (typeof result !== 'object' || result === null || !('kind' in result)
    || result.kind !== 'available' || !('data' in result) || !isReleasePrData(result.data)) return [];

  const data = result.data;
  const base = typeof window === 'undefined' ? undefined : new URL('/verse/', window.location.href).toString();
  const actionHref = paneLinkUrl('fleet-releases', null, false, base) ?? undefined;
  return data.repos.flatMap((entry) => {
    const pr = entry.pr;
    if (!pr?.blocked) return [];
    const safePr = { ...pr, failing: pr.failing.map(scrub),
      checks: pr.checks.map((check) => ({ ...check, name: scrub(check.name) })) };
    const [needsYou] = deriveReleaseNeedsYou({ kind: 'available', data: { ...data, repos: [{ ...entry, pr: safePr }] } }, nowMs);
    if (!needsYou) return [];
    return [{ id: `fleet-release-blocked:${entry.repo}:${pr.number}`, category: 'fleet' as const,
      severity: needsYou.severity === 'urgent' ? 'high' as const : 'medium' as const,
      title: `Release PR #${pr.number} is blocked`, detail: needsYou.detail, ts: pr.openedAt,
      actionLabel: 'Open releases', actionHref }];
  });
}
