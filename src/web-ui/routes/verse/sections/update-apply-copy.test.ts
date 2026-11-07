import { expect, it } from 'vitest';
import type { ApplyOutcome } from './update-apply-client.js';
import { applyOutcomeCopy } from './update-apply-copy.js';
const cases: [ApplyOutcome, string, string][] = [
  [{ kind: 'updated', toCommit: 'abcdef123', restart: 'sidecar' }, 'Updated to abcdef1. Phantom is restarting; this window reloads in a moment.', 'ok'],
  [{ kind: 'updated', toCommit: 'abcdef123', restart: 'manual' }, 'Updated to abcdef1. Quit and reopen Phantom to load it.', 'ok'],
  [{ kind: 'already-current' }, 'Already on the newest commit.', 'ok'],
  [{ kind: 'refused', reason: 'Dirty checkout' }, 'Update refused: Dirty checkout', 'warning'],
  [{ kind: 'failed', reason: 'Build failed' }, 'Update failed: Build failed', 'danger'],
  [{ kind: 'busy' }, 'An update is already running.', 'info'],
  [{ kind: 'not-in-build' }, 'This build cannot apply updates from here yet. Run `ashlr update` in a terminal.', 'warning'],
  [{ kind: 'locked' }, 'Unlock in Settings ▸ Connection ▸ Mutation hold, then press Update now again.', 'warning'],
];
it.each(cases)('describes %j', (outcome, text, tone) => { expect(applyOutcomeCopy(outcome)).toEqual({ text, tone }); });
