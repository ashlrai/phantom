export type ResourceBridgeLane = 'agy' | 'devin-flash' | 'zai';
export interface ResourceBridgePin {
  accountDigest: string;
  executableSha256: string;
}

type MeasuredQuota = { kind: 'measured'; usedPercent: number; observedAt: number; resetsAt: number };
type BridgeQualification =
  | { kind: 'verified'; quota: { kind: 'unknown' }; reservationCap: { maxConcurrent: number; maxPerHour: number } }
  | { kind: 'owner-attested-plan'; quota: MeasuredQuota; reservationCap: null };

const MAX_AGE = 300_000;
const MONTH = 30 * 86_400_000;
const HASH = /^[a-f0-9]{64}$/;

export function isResourceBridgeLane(value: unknown): value is ResourceBridgeLane {
  return value === 'agy' || value === 'devin-flash' || value === 'zai';
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property !== undefined && 'value' in property;
  });
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function isResourceBridgePin(value: unknown, lane: ResourceBridgeLane): value is ResourceBridgePin {
  return exact(value, ['accountDigest', 'executableSha256']) && typeof value.accountDigest === 'string' &&
    (lane === 'zai' ? /^[a-f0-9]{32}$/ : HASH).test(value.accountDigest) &&
    typeof value.executableSha256 === 'string' && HASH.test(value.executableSha256);
}

export function isResourceBridgeModel(lane: ResourceBridgeLane, model: string): boolean {
  if (lane === 'agy') return /^gemini-4-neon-(low|medium|high|xhigh)$/.test(model);
  if (lane === 'zai') return model === 'glm-5.3' || model === 'glm-5.3-flash';
  return model === 'swe-2-flash-max' || /^swe-2[.-]1(?:-[a-z0-9]+)*$/.test(model);
}

export function qualifyResourceBridgeEvidence(
  evidence: unknown, lane: ResourceBridgeLane, model: string, pin: ResourceBridgePin, now: number,
): BridgeQualification | null {
  const keys = ['schema', 'lane', 'model', 'accountDigest', 'executableSha256', 'observedAt', 'expiresAt', 'billing', 'quota'];
  if (!isResourceBridgePin(pin, lane) || !isResourceBridgeModel(lane, model) ||
      !integer(now, 0, 8.64e15 - MAX_AGE) || !exact(evidence, lane === 'devin-flash' ? [...keys, 'reservationCap'] : keys) ||
      evidence.schema !== 'resource-pool-bridge.v1' || evidence.lane !== lane || evidence.model !== model ||
      evidence.accountDigest !== pin.accountDigest || evidence.executableSha256 !== pin.executableSha256 ||
      !integer(evidence.observedAt, Math.max(0, now - MAX_AGE), now) ||
      !integer(evidence.expiresAt, now + 1, evidence.observedAt + MAX_AGE)) return null;
  const { billing, quota, reservationCap } = evidence;
  if (lane === 'devin-flash') {
    if (!exact(billing, ['kind', 'plan']) || billing.kind !== 'verified' || billing.plan !== 'devin-cli-free' ||
        !exact(quota, ['kind']) || quota.kind !== 'unknown' ||
        !exact(reservationCap, ['maxConcurrent', 'maxPerHour']) || !integer(reservationCap.maxConcurrent, 1, 16) ||
        !integer(reservationCap.maxPerHour, 1, 10_000)) return null;
    return { kind: 'verified', quota: { kind: 'unknown' },
      reservationCap: { maxConcurrent: reservationCap.maxConcurrent, maxPerHour: reservationCap.maxPerHour } };
  }
  const billingControl = lane === 'agy' ? 'useG1Credits' : 'autoRecharge';
  if (!exact(billing, ['kind', 'plan', 'attestedAt', 'attestationExpiresAt', billingControl]) ||
      billing.kind !== 'owner-attested-plan' || billing.plan !== (lane === 'agy' ? 'google-ai-ultra-personal' : 'zai-glm-coding-lite') ||
      billing[billingControl] !== false || !integer(billing.attestedAt, 0, evidence.observedAt) ||
      !integer(billing.attestationExpiresAt, evidence.expiresAt, billing.attestedAt + MONTH) ||
      !exact(quota, ['kind', 'usedPercent', 'observedAt', 'resetsAt']) || quota.kind !== 'measured' ||
      typeof quota.usedPercent !== 'number' || !Number.isFinite(quota.usedPercent) || quota.usedPercent < 0 || quota.usedPercent > 100 ||
      !integer(quota.observedAt, Math.max(0, now - MAX_AGE), evidence.observedAt) ||
      !integer(quota.resetsAt, evidence.expiresAt, 8.64e15) || evidence.expiresAt > quota.observedAt + MAX_AGE) return null;
  return { kind: 'owner-attested-plan', reservationCap: null,
    quota: { kind: 'measured', usedPercent: quota.usedPercent, observedAt: quota.observedAt, resetsAt: quota.resetsAt } };
}
