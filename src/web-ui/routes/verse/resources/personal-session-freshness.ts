import { DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS } from '../../../../core/resources/provider-aggregation-types.js';
import type { PersonalReading } from '../usage/codex-burn-model.js';

/** Feed the original observation deadline to the shared display clock. */
export function personalSessionExpiresAt(reading: PersonalReading | null, maxAgeMs?: number): string | null {
  const ageLimit = maxAgeMs ?? DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS;
  const at = Date.parse(reading?.asOf ?? '') + ageLimit;
  return Number.isFinite(ageLimit) && ageLimit > 0 && Number.isFinite(at) && Math.abs(at) <= 8.64e15
    ? new Date(at).toISOString() : null;
}

/** Display only: a successful file read does not renew the session observation. */
export function personalSessionCurrent(reading: PersonalReading | null, now: number, maxAgeMs?: number): boolean {
  const ageLimit = maxAgeMs ?? DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS;
  const observed = Date.parse(reading?.asOf ?? '');
  const reset = reading?.resetsAt === null ? null : Date.parse(reading?.resetsAt ?? '');
  return reading?.sourceState === 'healthy' && Number.isFinite(now) && now >= 0
    && Number.isFinite(ageLimit) && ageLimit > 0 && Number.isFinite(observed)
    && observed <= now && now - observed < ageLimit
    && (reset === null || Number.isFinite(reset) && reset > now);
}
