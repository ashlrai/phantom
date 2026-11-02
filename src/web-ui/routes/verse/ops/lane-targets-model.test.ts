import { describe, expect, it } from 'vitest';
import { captionFor, isLaneTargets, stepAllowed, type LaneTargetRow } from './lane-targets-model.js';

const row: LaneTargetRow = { lane: 'codex', target: 1, floor: 0, ceiling: 2, held: false, heldReason: null, heldUntil: null, lastChange: '2026-10-31T12:00:00Z', changedBy: 'Phantom desktop' };
const payload = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [row] };

describe('lane target model', () => {
  it('accepts the wire shape and rejects malformed fields', () => {
    expect(isLaneTargets(payload)).toBe(true);
    for (const value of [null, [], { ...payload, v: 2 }, { ...payload, generatedAt: null }, { ...payload, sourceState: 'unknown' }, { ...payload, lanes: null }, ...['lane', 'target', 'floor', 'ceiling', 'held', 'heldReason', 'heldUntil', 'lastChange', 'changedBy'].map(key => ({ ...payload, lanes: [{ ...row, [key]: undefined }] })), { ...payload, lanes: [{ ...row, target: 1.5 }] }]) {
      expect(isLaneTargets(value)).toBe(false);
    }
  });
  it('allows only steps within both bounds', () => {
    expect(stepAllowed(row, -1)).toBe(true);
    expect(stepAllowed(row, 1)).toBe(true);
    expect(stepAllowed({ ...row, target: 0 }, -1)).toBe(false);
    expect(stepAllowed({ ...row, target: 2 }, 1)).toBe(false);
    expect(stepAllowed(row, 2)).toBe(false);
  });
  it('describes changes and holds without inventing missing times', () => {
    const now = Date.parse('2026-10-31T12:05:00Z');
    expect(captionFor(row, now)).toBe('changed 5 min ago by Phantom desktop');
    expect(captionFor({ ...row, held: true, heldReason: 'budget' }, now)).toBe('held: budget');
    expect(captionFor({ ...row, held: true }, now)).toBe('held: reason unavailable');
    expect(captionFor({ ...row, lastChange: 'invalid' }, now)).toBe('');
    expect(captionFor({ ...row, lastChange: '2026-11-01T12:00:00Z' }, now)).toBe('');
  });
});
