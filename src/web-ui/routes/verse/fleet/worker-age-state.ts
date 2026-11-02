export type AgeState = 'normal' | 'long' | 'stuck';

export function laneAgeThresholds(lane: string): { longSec: number; stuckSec: number } {
  const [long, stuck] = lane === 'devin' ? [90, 180] : lane === 'codex-local' ? [60, 120] : [30, 60];
  return { longSec: long * 60, stuckSec: stuck * 60 };
}

export function workerAgeState(lane: string, ageSeconds: number | null): AgeState {
  if (ageSeconds === null) return 'normal';
  const { longSec, stuckSec } = laneAgeThresholds(lane);
  return ageSeconds > stuckSec ? 'stuck' : ageSeconds > longSec ? 'long' : 'normal';
}

export function ageStateText(state: AgeState, lane: string): string | null {
  if (state === 'normal') return null;
  const { longSec, stuckSec } = laneAgeThresholds(lane);
  return state === 'long' ? `Long for this lane (over ${longSec / 60} min)`
    : `Likely stuck (over ${stuckSec / 60} min); open its log`;
}
