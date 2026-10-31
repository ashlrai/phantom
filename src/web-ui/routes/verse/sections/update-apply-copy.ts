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

export function applyOutcomeCopy(outcome: ApplyOutcome): { text: string; tone: 'ok' | 'warning' | 'danger' | 'info' } {
  switch (outcome.kind) {
    case 'updated': return { tone: 'ok', text: `Updated to ${outcome.toCommit.slice(0, 7)}. ${outcome.restart === 'sidecar'
      ? 'Phantom is restarting; this window reloads in a moment.' : 'Quit and reopen Phantom to load it.'}` };
    case 'already-current': return { tone: 'ok', text: 'Already on the newest commit.' };
    case 'refused': return { tone: 'warning', text: `Update refused: ${outcome.reason}` };
    case 'failed': return { tone: 'danger', text: `Update failed: ${outcome.reason}` };
    case 'busy': return { tone: 'info', text: 'An update is already running.' };
    case 'not-in-build': return { tone: 'warning', text: 'This build cannot apply updates from here yet. Run `ashlr update` in a terminal.' };
    case 'locked': return { tone: 'warning', text: 'Unlock mutations in Settings ▸ Connection first.' };
  }
}
