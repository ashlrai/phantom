import { expect, it } from 'vitest';
import { nextTarget, stepperState } from './lane-target-stepper-model.js';

const row = { lane: 'codex', target: 1, floor: 0, ceiling: 3, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const base = { row, pending: false, confirm: null, hasHold: true, now: 1000 };

it('clamps target steps to the permitted range', () => {
  expect(nextTarget(0, -1)).toBe(0);
  expect(nextTarget(999, 1)).toBe(999);
  expect(nextTarget(5, 1)).toBe(6);
});

it('shows confirmation only during the window for the matching lane', () => {
  expect(stepperState({ ...base, confirm: { lane: 'codex', until: 1001 } }).caption).toBe('Press − again to set 0');
  expect(stepperState({ ...base, confirm: { lane: 'codex', until: 1000 } }).caption).toBe('');
  expect(stepperState({ ...base, confirm: { lane: 'other', until: 1001 } }).caption).toBe('');
});

it('disables both controls while pending or without the hold', () => {
  for (const state of [{ ...base, pending: true }, { ...base, hasHold: false }]) {
    expect(stepperState(state)).toMatchObject({ lowerDisabled: true, raiseDisabled: true });
  }
  expect(stepperState(base)).toMatchObject({ lowerDisabled: false, raiseDisabled: false });
  expect(stepperState({ ...base, row: { ...row, target: 0 } }).lowerDisabled).toBe(true);
  expect(stepperState({ ...base, row: { ...row, target: 3 } }).raiseDisabled).toBe(true);
});
