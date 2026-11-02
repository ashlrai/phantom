import { describe, expect, it } from 'vitest';
import type { LaneTargetRow, LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { heldLaneItems } from './needs-holds-model.js';

const now = Date.parse('2026-10-31T22:00:00Z');
const row = (lane: string, overrides: Partial<LaneTargetRow> = {}): LaneTargetRow => ({
  lane, target: 0, floor: 0, ceiling: 8, held: true, heldReason: 'usage limit',
  heldUntil: null, lastChange: null, changedBy: 'autobackoff', ...overrides,
});
const targets = (lanes: LaneTargetRow[]): LaneTargetsV1 => ({ v: 1, generatedAt: '', sourceState: 'healthy', lanes });

describe('heldLaneItems', () => {
  it('lists every held lane in lane order with its reason, expiry and release authority', () => {
    expect(heldLaneItems(targets([
      row('zeta', { heldReason: null, changedBy: 'Mason' }),
      row('free', { held: false }),
      row('codex-personal', { heldUntil: '2026-10-31T22:40:00Z' }),
    ]), now)).toEqual([
      { lane: 'codex-personal', title: 'codex-personal is held', subtitle: 'usage limit · clears in 40 m', releasable: true },
      { lane: 'zeta', title: 'zeta is held', subtitle: 'reason unavailable · no end set', releasable: false },
    ]);
  });

  it('distinguishes an invalid expiry from a hold without an end', () => {
    expect(heldLaneItems(targets([row('bad', { heldUntil: 'invalid' })]), now)[0]?.subtitle)
      .toBe('usage limit · clear time unavailable');
    expect(heldLaneItems(null, now)).toEqual([]);
  });
});
