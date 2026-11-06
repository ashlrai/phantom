import type { ApplyOutcome, ApplyStep } from './update-apply-client.js';

export function applyStepsCopy(steps: ApplyStep[] | undefined): Array<{ label: string; status: 'ok' | 'failed'; duration: string }> {
  const labels = new Map([['status', 'Status'], ['fetch', 'Fetch'], ['ahead', 'Ahead check'], ['update', 'Update']]);
  return (steps ?? []).map(({ name, ok, ms }) => {
    const seconds = Math.round(ms / 1000);
    const duration = ms < 9950 ? `${Math.round(ms / 100) / 10}s` : seconds < 60 ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
    return { label: labels.get(name) ?? name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
      status: ok ? 'ok' : 'failed', duration };
  });
}

export function applyNextStep(reason: string): string | null {
  const steps: Array<[string, string]> = [
    ['dirty tree', 'Commit or stash local changes in the Phantom checkout, then press Update now.'],
    ['diverged', 'Your checkout has commits master does not. Run `ashlr update` in a terminal to rebase or reset.'],
    ['fetch failed', 'Check the network and the origin remote, then press Check now.'],
    ['origin/master unresolvable', 'Check the network and the origin remote, then press Check now.'],
    ['head unresolvable', 'The checkout is broken. Run `git status` in the Phantom folder.'],
    ['merge-base timedout', 'Git took too long; the Mac is busy. Try again in a few minutes.'],
    ['update timedout', 'Git took too long; the Mac is busy. Try again in a few minutes.'],
    ['update failed', 'See the step note below, then run `ashlr update` in a terminal.'],
  ];
  const normalized = reason.toLowerCase();
  return steps.find(([prefix]) => normalized.startsWith(prefix))?.[1] ?? null;
}

export function applyOutcomeCopy(outcome: ApplyOutcome): { text: string; tone: 'ok' | 'warning' | 'danger' | 'info' } {
  switch (outcome.kind) {
    case 'updated': return { tone: 'ok', text: `Updated to ${outcome.toCommit.slice(0, 7)}. ${outcome.restart === 'sidecar'
      ? 'Phantom is restarting; this window reloads in a moment.' : 'Quit and reopen Phantom to load it.'}` };
    case 'already-current': return { tone: 'ok', text: 'Already on the newest commit.' };
    case 'refused':
    case 'failed': {
      const nextStep = applyNextStep(outcome.reason);
      return { tone: outcome.kind === 'refused' ? 'warning' : 'danger',
        text: `Update ${outcome.kind}: ${outcome.reason}${nextStep ? ` · ${nextStep}` : ''}` };
    }
    case 'busy': return { tone: 'info', text: 'An update is already running.' };
    case 'not-in-build': return { tone: 'warning', text: 'This build cannot apply updates from here yet. Run `ashlr update` in a terminal.' };
    case 'locked': return { tone: 'warning', text: 'Unlock in Settings ▸ Connection ▸ Mutation hold, then press Update now again.' };
  }
}
