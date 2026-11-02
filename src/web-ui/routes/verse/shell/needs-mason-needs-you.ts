import type { FleetNeedsYouItem } from './fleet-needs-you.js';
import type { NeedsMasonResult } from './needs-mason-query.js';

/**
 * One Needs-you row per open line of NEEDS-MASON.md — steps only Mason can do
 * (Keychain prompts, Automation permission). 'absent' is silence; 'unreadable'
 * gets one row so a blocked file still reaches him.
 */
export function deriveNeedsMasonNeedsYou(read: NeedsMasonResult | undefined): FleetNeedsYouItem[] {
  if (read?.kind !== 'available') return [];
  if (read.data.state === 'unreadable') {
    return [{
      id: 'needs-mason-unreadable', severity: 'attention', target: 'fleet',
      title: 'NEEDS-MASON.md could not be read',
      detail: 'Only you can do this step.',
      nextStep: 'Check that ~/.ashlr-runs/NEEDS-MASON.md is a regular file under 32 KB',
    }];
  }
  return read.data.items.map(item => ({
    id: `needs-mason-${item.id}`, severity: 'attention', target: 'fleet',
    title: item.text,
    detail: 'Only you can do this step.',
    nextStep: 'Open ~/.ashlr-runs/NEEDS-MASON.md and tick the line when done',
  }));
}
