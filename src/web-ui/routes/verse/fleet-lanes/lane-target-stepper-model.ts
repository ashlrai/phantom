import { captionFor, stepAllowed, type LaneTargetRow } from '../ops/lane-targets-model.js';

export function nextTarget(current: number, delta: -1 | 1): number {
  return Math.max(0, Math.min(999, current + delta));
}

export function stepperState({ row, pending, confirm, hasHold, now }: {
  row: LaneTargetRow | undefined;
  pending: boolean;
  confirm: { lane: string; until: number } | null;
  hasHold: boolean;
  now: number;
}): { lowerDisabled: boolean; raiseDisabled: boolean; caption: string } {
  const disabled = !row || pending || !hasHold;
  return {
    lowerDisabled: disabled || !stepAllowed(row, -1) || nextTarget(row.target, -1) === row.target,
    raiseDisabled: disabled || !stepAllowed(row, 1) || nextTarget(row.target, 1) === row.target,
    caption: row && confirm?.lane === row.lane && row.target === 1 && now < confirm.until
      ? 'Press − again to set 0' : row ? captionFor(row, now) : '',
  };
}
