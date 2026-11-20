/**
 * Historical ordered slot accounting over caller-supplied RECORDED rows. Pure:
 * no account lookup, selection, reserve, availability, model call, spawn,
 * dispatch, network, filesystem or clock read.
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * src/core/providers/coding-cli/worker-plan.ts planWorker(): slot = accountId
 * ?? backend; cap check; a fitting row increments its slot for later rows.
 *
 * Deliberate differences from the source (which defaulted cap to 1 and count
 * to 0): a missing cap or count is `unknown`; a zero cap is `full` even when
 * the count is unknown, because no count is below zero; an `unknown` row may
 * have taken its slot, so later counts on that slot are `unknown`; malformed
 * input throws with messages that never echo values; input is only read.
 *
 * `fits` is a recorded concurrency calculation. It is NOT dispatch permission,
 * live availability, quota or billing eligibility.
 */

export const RECORDED_SLOT_PROJECTION_PROVENANCE = {
  sourcePr: 5952,
  sourceHead: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  sourcePath: 'src/core/providers/coding-cli/worker-plan.ts',
  sourceFunction: 'planWorker',
  basis: 'historical-offline',
  evidence: 'recorded-concurrency-calculation',
  dispatchPermission: false,
  liveAvailability: false,
  billingEligibility: false,
} as const;

/** One recorded row. An absent or null `accountId` uses the backend slot. */
export interface RecordedSlotCandidate {
  readonly jobId: string;
  readonly backend: string;
  readonly accountId?: string | null;
}

export interface RecordedSlotProjectionInput {
  readonly candidates: readonly RecordedSlotCandidate[];
  /** Per-backend cap. Absent or null is unknown. */
  readonly concurrency?: Readonly<Record<string, number | null | undefined>>;
  /** Recorded in-flight count per effective slot. Absent or null is unknown. */
  readonly inFlight?: Readonly<Record<string, number | null | undefined>>;
}

/** `fits`: below a known cap with a known count. `full`: at or above the cap. */
export type RecordedSlotStatus = 'fits' | 'full' | 'unknown';

export interface RecordedSlotObservation {
  readonly index: number;
  readonly jobId: string;
  readonly backend: string;
  readonly slotKind: 'account' | 'backend';
  readonly slot: string;
  readonly cap: number | null;
  readonly countBefore: number | null;
  readonly countAfter: number | null;
  readonly status: RecordedSlotStatus;
  readonly incremented: boolean;
}

export interface RecordedSlotProjection {
  readonly provenance: typeof RECORDED_SLOT_PROJECTION_PROVENANCE;
  readonly observations: readonly RecordedSlotObservation[];
  /** Projected count per referenced slot, first-referenced order. `null` is unknown. */
  readonly finalCounts: readonly { readonly slot: string; readonly count: number | null }[];
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RangeError(`recorded slot projection: ${label} must be a non-blank string`);
  }
  return value;
}

/** Copies a caller map. Absent, undefined and null entries are unknown and omitted. */
function copyCounts(map: object | undefined, label: string): Map<string, number> {
  const out = new Map<string, number>();
  if (map === undefined) return out;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new TypeError(`recorded slot projection: ${label} must be an object`);
  }
  for (const [key, value] of Object.entries(map)) {
    requireId(key, `${label} key`);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`recorded slot projection: ${label} value must be a non-negative safe integer`);
    }
    out.set(key, value);
  }
  return out;
}

/** Projects rows in order against per-backend caps and initial in-flight counts. */
export function projectRecordedSlots(input: RecordedSlotProjectionInput): RecordedSlotProjection {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('recorded slot projection: input must be an object');
  }
  if (!Array.isArray(input.candidates)) {
    throw new TypeError('recorded slot projection: candidates must be an array');
  }
  const caps = copyCounts(input.concurrency, 'concurrency');
  const seeded = copyCounts(input.inFlight, 'inFlight');
  const state = new Map<string, number | null>();
  const observations: RecordedSlotObservation[] = [];

  input.candidates.forEach((row: RecordedSlotCandidate, index: number) => {
    if (typeof row !== 'object' || row === null) {
      throw new TypeError(`recorded slot projection: candidate ${index} must be an object`);
    }
    const jobId = requireId(row.jobId, `candidate ${index} jobId`);
    const backend = requireId(row.backend, `candidate ${index} backend`);
    const hasAccount = row.accountId !== undefined && row.accountId !== null;
    const slot = hasAccount ? requireId(row.accountId, `candidate ${index} accountId`) : backend;
    if (!state.has(slot)) state.set(slot, seeded.get(slot) ?? null);

    const before = state.get(slot) ?? null;
    const cap = caps.get(backend) ?? null;
    let status: RecordedSlotStatus;
    if (cap === null) status = 'unknown';
    else if (cap <= 0) status = 'full';
    else if (before === null) status = 'unknown';
    else status = before >= cap ? 'full' : 'fits';

    let after: number | null = before;
    if (status === 'fits') after = (before ?? 0) + 1;
    else if (status === 'unknown') after = null;
    if (status !== 'full') state.set(slot, after);

    observations.push({
      index,
      jobId,
      backend,
      slotKind: hasAccount ? 'account' : 'backend',
      slot,
      cap,
      countBefore: before,
      countAfter: after,
      status,
      incremented: status === 'fits',
    });
  });

  return {
    provenance: RECORDED_SLOT_PROJECTION_PROVENANCE,
    observations,
    finalCounts: [...state].map(([slot, count]) => ({ slot, count })),
  };
}
