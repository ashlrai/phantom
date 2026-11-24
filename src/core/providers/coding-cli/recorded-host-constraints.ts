/**
 * Historical host-floor check over one recorded assignment. Pure, recorded input
 * only (no clock, env, filesystem, network or provider reads).
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * scheduler/pools.ts hostBlocks(). Preserved: non-Mac pools bypass the floors;
 * Mac disk strictly below the disk floor blocks; Mac battery strictly below the
 * battery floor blocks; equality does not block.
 *
 * Deliberate differences: the source treated a null measurement as "not
 * blocking" and always had default floors. Here a missing measurement or floor is
 * `unknown` (no defaults invented) unless another known measurement already
 * proves a block. Supplied non-finite/negative values, battery or floor outside
 * [0, 100] throw RangeError instead of producing NaN comparisons.
 *
 * The result explains a RECORDED assignment. It is not live admission, host
 * health, or permission to dispatch.
 */

export const RECORDED_HOST_CONSTRAINTS_PROVENANCE = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'historical-offline',
} as const;

export interface RecordedHostEvidence {
  readonly host: string;
  readonly diskFreeGb?: number | null;
  readonly batteryPercent?: number | null;
  readonly diskFloorGb?: number | null;
  readonly batteryFloorPercent?: number | null;
}

export type RecordedHostBlockReason = 'disk-below-floor' | 'battery-below-floor';
export type RecordedHostUnknownField = 'diskFreeGb' | 'diskFloorGb' | 'batteryPercent' | 'batteryFloorPercent';

export type RecordedHostConstraintResult = (
  | { readonly status: 'bypassed' }
  | { readonly status: 'not-blocked' }
  | { readonly status: 'blocked'; readonly reasons: readonly RecordedHostBlockReason[] }
  | { readonly status: 'unknown'; readonly missing: readonly RecordedHostUnknownField[] }
) & {
  readonly provenance: typeof RECORDED_HOST_CONSTRAINTS_PROVENANCE;
  readonly historicalOnly: true;
};

function checked(name: string, value: number | null | undefined, max: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be a finite number in [0, ${max}]`);
  }
  return value;
}

export function explainRecordedHostConstraints(evidence: RecordedHostEvidence): RecordedHostConstraintResult {
  const base = { provenance: RECORDED_HOST_CONSTRAINTS_PROVENANCE, historicalOnly: true } as const;
  if (evidence.host !== 'mac') return { status: 'bypassed', ...base };
  const disk = checked('diskFreeGb', evidence.diskFreeGb, Number.MAX_VALUE);
  const diskFloor = checked('diskFloorGb', evidence.diskFloorGb, Number.MAX_VALUE);
  const battery = checked('batteryPercent', evidence.batteryPercent, 100);
  const batteryFloor = checked('batteryFloorPercent', evidence.batteryFloorPercent, 100);

  const reasons: RecordedHostBlockReason[] = [];
  const missing: RecordedHostUnknownField[] = [];
  if (disk !== null && diskFloor !== null) {
    if (disk < diskFloor) reasons.push('disk-below-floor');
  } else {
    if (disk === null) missing.push('diskFreeGb');
    if (diskFloor === null) missing.push('diskFloorGb');
  }
  if (battery !== null && batteryFloor !== null) {
    if (battery < batteryFloor) reasons.push('battery-below-floor');
  } else {
    if (battery === null) missing.push('batteryPercent');
    if (batteryFloor === null) missing.push('batteryFloorPercent');
  }
  if (reasons.length > 0) return { status: 'blocked', reasons, ...base };
  if (missing.length > 0) return { status: 'unknown', missing, ...base };
  return { status: 'not-blocked', ...base };
}
