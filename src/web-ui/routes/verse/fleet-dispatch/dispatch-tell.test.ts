import { expect, it } from 'vitest';
import { dispatchTellKinds, dispatchTellPrefill } from './dispatch-tell.js';

it('selects only starved, down and held verdicts', () => {
  expect(dispatchTellKinds()).toEqual(new Set(['starved', 'down', 'held']));
});

it('prefills a starved lane with its headline and free slots', () => {
  expect(dispatchTellPrefill({ lane: 'codex-personal', kind: 'starved', free: 16, headline: 'last tick 9 min ago' }))
    .toBe('Re lane codex-personal (starved, 16 free slots): last tick 9 min ago. ');
});

it('caps long prefills at 400 characters with an ellipsis', () => {
  const prefill = dispatchTellPrefill({ lane: 'codex-personal', kind: 'held', free: 16, headline: 'x'.repeat(500) });
  expect(prefill).toHaveLength(400);
  expect(prefill).toMatch(/^Re lane codex-personal \(held, 16 free slots\): x+…$/);
});
