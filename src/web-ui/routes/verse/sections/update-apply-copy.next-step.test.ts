import { expect, it } from 'vitest';
import { applyNextStep, applyOutcomeCopy } from './update-apply-copy.js';

const cases: Array<['refused' | 'failed', string, string]> = [
  ['refused', 'dirty tree', 'Commit or stash local changes in the Phantom checkout, then press Update now.'],
  ['refused', 'diverged', 'Your checkout has commits master does not. Run `ashlr update` in a terminal to rebase or reset.'],
  ['failed', 'fetch failed', 'Check the network and the origin remote, then press Check now.'],
  ['failed', 'origin/master unresolvable', 'Check the network and the origin remote, then press Check now.'],
  ['failed', 'HEAD unresolvable', 'The checkout is broken. Run `git status` in the Phantom folder.'],
  ['failed', 'merge-base timedOut', 'Git took too long; the Mac is busy. Try again in a few minutes.'],
  ['failed', 'update timedOut', 'Git took too long; the Mac is busy. Try again in a few minutes.'],
  ['failed', 'update failed', 'See the step note below, then run `ashlr update` in a terminal.'],
];

it.each(cases)('adds a next step for %s: %s', (kind, reason, nextStep) => {
  expect(applyNextStep(reason)).toBe(nextStep);
  expect(applyOutcomeCopy({ kind, reason })).toEqual({
    tone: kind === 'refused' ? 'warning' : 'danger',
    text: `Update ${kind}: ${reason} · ${nextStep}`,
  });
});

it('matches a reason prefix without regard to case and preserves its details', () => {
  const reason = 'DIRTY TREE (3 files)';
  const nextStep = 'Commit or stash local changes in the Phantom checkout, then press Update now.';
  expect(applyNextStep(reason)).toBe(nextStep);
  expect(applyOutcomeCopy({ kind: 'refused', reason })).toEqual({
    tone: 'warning', text: `Update refused: ${reason} · ${nextStep}`,
  });
});

it.each(['refused', 'failed'] as const)('keeps the old %s copy for an unknown reason', (kind) => {
  expect(applyNextStep('unknown reason')).toBeNull();
  expect(applyOutcomeCopy({ kind, reason: 'unknown reason' })).toEqual({
    tone: kind === 'refused' ? 'warning' : 'danger', text: `Update ${kind}: unknown reason`,
  });
});

it('preserves updated, locked, and busy copy', () => {
  expect(applyOutcomeCopy({ kind: 'updated', toCommit: 'abcdef123', restart: 'sidecar' })).toEqual({
    tone: 'ok', text: 'Updated to abcdef1. Phantom is restarting; this window reloads in a moment.',
  });
  expect(applyOutcomeCopy({ kind: 'locked' })).toEqual({
    tone: 'warning', text: 'Unlock in Settings ▸ Connection ▸ Mutation hold, then press Update now again.',
  });
  expect(applyOutcomeCopy({ kind: 'busy' })).toEqual({ tone: 'info', text: 'An update is already running.' });
});
