import type { FleetNeedsYouItem } from './fleet-needs-you.js';
import type { StuckFixesRead } from './stuck-fixes-query.js';

const MAX_ROWS = 5;
const URGENT_AFTER_MINUTES = 60;

export function deriveStuckFixesNeedsYou(read: StuckFixesRead | undefined): FleetNeedsYouItem[] {
  if (read?.kind !== 'available' || !read.data.known) return [];
  return [...read.data.stuck].sort((a, b) => b.ageMinutes - a.ageMinutes).slice(0, MAX_ROWS).map(fix => {
    const number = /\/pull\/(\d+)/.exec(fix.prUrl)?.[1];
    return {
      id: `stuck-fix-${fix.job}`, target: 'fleet' as const,
      severity: fix.ageMinutes >= URGENT_AFTER_MINUTES ? 'urgent' as const : 'attention' as const,
      title: `${fix.repo ?? 'unknown repo'} fix PR stuck ${fix.ageMinutes} min`,
      detail: `${fix.job} · ${number ? `#${number}` : 'PR'}`,
      nextStep: 'Check why the guardian fix PR has not merged',
      open: { kind: 'terminal' as const, command: 'ashlr fleet stuck-fixes' },
    };
  });
}
