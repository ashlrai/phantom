import type { ApplyOutcome } from './update-apply-client.js';

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
