/**
 * Shared pure validation, numeric, and domain-enum primitives for offline
 * coding-CLI modules. No I/O, clock, environment, network, or process access.
 */

/** Billing classes shared across recorded catalog and runtime-pool schemas. */
export const CODING_CLI_BILLING_CLASSES = ['subscription', 'metered', 'local', 'loopback'] as const;
export type CodingCliBillingClass = (typeof CODING_CLI_BILLING_CLASSES)[number];

/** Consumers of the shared Grok Ultra weekly limit. */
export const CODING_CLI_ULTRA_CONSUMERS = ['orchestrator', 'cloud-agent'] as const;
export type CodingCliUltraConsumer = (typeof CODING_CLI_ULTRA_CONSUMERS)[number];

/** Largest valid unsigned 32-bit process exit code. */
const MAX_EXIT_CODE = 0xffff_ffff;

/** Structural posterior arm shape validated by posterior update and sampling modules. */
export interface PosteriorArmFields {
  alpha: number;
  beta: number;
  qualityMean: number;
  qualityM2: number;
  latencyMean: number;
  latencyM2: number;
  tokenMean: number;
  tokenM2: number;
  tokenObservations: number;
  observations: number;
}

const rangeError = (message: string): Error => new RangeError(message);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isExitCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_EXIT_CODE;
}

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Round to six decimal places, normalizing `-0` to `+0`. */
export function round6(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return rounded === 0 ? 0 : rounded;
}

export function requireNulFreeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

export function requireNullableNulFreeIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : requireNulFreeIdentifier(value, label);
}

export function assertFiniteNumber(
  value: unknown,
  name: string,
  makeError: (message: string) => Error = rangeError,
): number {
  if (!isFiniteNumber(value)) throw makeError(`${name} must be a finite number`);
  return value;
}

function assertNonNegativeInteger(
  value: unknown,
  name: string,
  makeError: (message: string) => Error = rangeError,
): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw makeError(`${name} must be a non-negative integer`);
  }
  return value as number;
}

/** Validate a posterior arm state, throwing via `makeError` on the first violation. */
export function validatePosteriorArmState(
  arm: PosteriorArmFields,
  makeError: (message: string) => Error = rangeError,
  options?: { requireZeroTokensWhenUnobserved?: boolean },
): void {
  for (const name of ['alpha', 'beta'] as const) {
    if (assertFiniteNumber(arm[name], `arm.${name}`, makeError) <= 0) {
      throw makeError(`arm.${name} must be > 0`);
    }
  }
  for (const name of ['qualityMean', 'latencyMean', 'tokenMean'] as const) {
    assertFiniteNumber(arm[name], `arm.${name}`, makeError);
  }
  for (const name of ['qualityM2', 'latencyM2', 'tokenM2'] as const) {
    if (assertFiniteNumber(arm[name], `arm.${name}`, makeError) < 0) {
      throw makeError(`arm.${name} must be >= 0`);
    }
  }
  const observations = assertNonNegativeInteger(arm.observations, 'arm.observations', makeError);
  const tokenObservations = assertNonNegativeInteger(arm.tokenObservations, 'arm.tokenObservations', makeError);
  if (tokenObservations > observations) {
    throw makeError('arm.tokenObservations must not exceed arm.observations');
  }
  if (options?.requireZeroTokensWhenUnobserved && tokenObservations === 0 && (arm.tokenMean !== 0 || arm.tokenM2 !== 0)) {
    throw makeError('arm token statistics must be zero when tokenObservations is 0');
  }
}
