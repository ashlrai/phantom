import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { WorkItem } from '../types.js';

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const SHA256_JSON_FILE_RE = /^[a-f0-9]{64}\.json$/;
export const POLICY_IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const LEARNING_WORK_SOURCES: ReadonlySet<WorkItem['source']> = new Set<WorkItem['source']>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint',
  'goal', 'hygiene', 'invent',
]);

export interface PolicyAssignmentUnitIdentity {
  repo: string;
  workItemId: string;
  workSource: string;
  workItemGenerationId: string;
  objectiveHash: string;
  campaignDigest: string;
  eligibilityPopulationDigest: string;
  policyVersion: string;
  learningEpoch: string;
}

export function isSha256JsonFileName(fileName: string): boolean {
  return SHA256_JSON_FILE_RE.test(fileName);
}

export function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

export function sha256Tuple(domain: string, values: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([domain, ...values]), 'utf8')
    .digest('hex');
}

export function hmacSha256Tuple(
  key: Buffer,
  domain: string,
  values: readonly unknown[],
): string {
  return createHmac('sha256', key)
    .update(JSON.stringify([domain, ...values]), 'utf8')
    .digest('hex');
}

export function equalSha256Hex(left: string, right: string): boolean {
  if (!SHA256_HEX_RE.test(left) || !SHA256_HEX_RE.test(right)) return false;
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function canonicalRealPath(value: unknown, maxLength?: number): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (maxLength !== undefined && value.length > maxLength) ||
    !isAbsolute(value)
  ) return null;
  try {
    const canonical = realpathSync(value);
    return isAbsolute(canonical) && (maxLength === undefined || canonical.length <= maxLength)
      ? canonical
      : null;
  } catch {
    return null;
  }
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Shared formula only; callers retain responsibility for canonical validation. */
export function policyAssignmentUnitId(
  key: Buffer,
  input: PolicyAssignmentUnitIdentity,
): string {
  return hmacSha256Tuple(key, 'ashlr:policy-assignment-unit:v1', [
    input.repo,
    input.workItemId,
    input.workSource,
    input.workItemGenerationId,
    input.objectiveHash,
    input.campaignDigest,
    input.eligibilityPopulationDigest,
    input.policyVersion,
    input.learningEpoch,
  ]);
}
