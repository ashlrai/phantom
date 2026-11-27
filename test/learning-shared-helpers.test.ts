import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LEARNING_WORK_SOURCES,
  POLICY_IDENTIFIER_RE,
  SHA256_HEX_RE,
  canonicalRealPath,
  equalSha256Hex,
  exactKeys,
  hmacSha256Tuple,
  isCanonicalIsoTimestamp,
  isSha256JsonFileName,
  optionalBoolean,
  policyAssignmentUnitId,
  sha256Tuple,
} from '../src/core/learning/policy-assignment-identity.js';

const KEY = Buffer.alloc(32, 0x2a);
const ALT_KEY = Buffer.alloc(32, 0x5c);
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('learning shared receipt and validation helpers', () => {
  it('validates SHA-256 hex digests, json filenames, policy ids, and work sources', () => {
    expect(SHA256_HEX_RE.test(DIGEST_A)).toBe(true);
    expect(SHA256_HEX_RE.test('A'.repeat(64))).toBe(false);
    expect(SHA256_HEX_RE.test('a'.repeat(63))).toBe(false);

    expect(isSha256JsonFileName(`${DIGEST_A}.json`)).toBe(true);
    expect(isSha256JsonFileName(`${DIGEST_A}.txt`)).toBe(false);
    expect(isSha256JsonFileName(`.${DIGEST_A}.json`)).toBe(false);

    expect(POLICY_IDENTIFIER_RE.test('router-v1.2_a')).toBe(true);
    expect(POLICY_IDENTIFIER_RE.test('a'.repeat(64))).toBe(true);
    expect(POLICY_IDENTIFIER_RE.test('a'.repeat(65))).toBe(false);
    expect(POLICY_IDENTIFIER_RE.test('-leading-dash')).toBe(false);
    expect(POLICY_IDENTIFIER_RE.test('UPPER')).toBe(false);

    expect(LEARNING_WORK_SOURCES.has('issue')).toBe(true);
    expect(LEARNING_WORK_SOURCES.has('invent')).toBe(true);
    expect(LEARNING_WORK_SOURCES.size).toBe(12);
  });

  it('validates canonical ISO-8601 timestamps and exact key sets', () => {
    expect(isCanonicalIsoTimestamp('2026-11-26T12:34:56.789Z')).toBe(true);
    expect(isCanonicalIsoTimestamp('2026-11-26T12:34:56Z')).toBe(false);
    expect(isCanonicalIsoTimestamp('2026-11-26T12:34:56.000+00:00')).toBe(false);
    expect(isCanonicalIsoTimestamp('not-a-timestamp')).toBe(false);
    expect(isCanonicalIsoTimestamp(123456)).toBe(false);

    expect(exactKeys({ b: 2, a: 1 }, ['a', 'b'])).toBe(true);
    expect(exactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(exactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);
    // Reject comma-spoofed key boundaries that a join(',') comparison could conflate.
    expect(exactKeys({ 'a,b': 1 }, ['a', 'b'])).toBe(false);
  });

  it('computes domain-separated SHA-256 and HMAC-SHA-256 tuples and compares digests safely', () => {
    const sha = sha256Tuple('ashlr:test:v1', ['alpha', 42, null]);
    const expectedSha = createHash('sha256')
      .update(JSON.stringify(['ashlr:test:v1', 'alpha', 42, null]), 'utf8')
      .digest('hex');
    expect(sha).toBe(expectedSha);
    expect(sha).not.toBe(sha256Tuple('ashlr:test:v2', ['alpha', 42, null]));

    const mac = hmacSha256Tuple(KEY, 'ashlr:test:v1', ['alpha', 42]);
    const expectedMac = createHmac('sha256', KEY)
      .update(JSON.stringify(['ashlr:test:v1', 'alpha', 42]), 'utf8')
      .digest('hex');
    expect(mac).toBe(expectedMac);
    expect(mac).not.toBe(hmacSha256Tuple(ALT_KEY, 'ashlr:test:v1', ['alpha', 42]));
    expect(mac).not.toBe(hmacSha256Tuple(KEY, 'ashlr:test:v2', ['alpha', 42]));

    expect(equalSha256Hex(sha, expectedSha)).toBe(true);
    expect(equalSha256Hex(DIGEST_A, DIGEST_B)).toBe(false);
    expect(equalSha256Hex('not-hex', 'not-hex')).toBe(false);
    expect(equalSha256Hex(DIGEST_A, DIGEST_A.toUpperCase())).toBe(false);

    const unitId = policyAssignmentUnitId(KEY, {
      repo: '/repo',
      workItemId: 'item-1',
      workSource: 'issue',
      workItemGenerationId: DIGEST_A,
      objectiveHash: DIGEST_B,
      campaignDigest: DIGEST_A,
      eligibilityPopulationDigest: DIGEST_B,
      policyVersion: 'router-v1',
      learningEpoch: '2026-11-26',
    });
    expect(unitId).toBe(hmacSha256Tuple(KEY, 'ashlr:policy-assignment-unit:v1', [
      '/repo',
      'item-1',
      'issue',
      DIGEST_A,
      DIGEST_B,
      DIGEST_A,
      DIGEST_B,
      'router-v1',
      '2026-11-26',
    ]));
  });

  it('canonicalizes existing absolute real paths and enforces optional length bounds', () => {
    const base = mkdtempSync(join(tmpdir(), 'ashlr-learning-shared-'));
    tempDirs.push(base);
    const targetDir = join(base, 'real-repo');
    const linkDir = join(base, 'alias-repo');
    mkdirSync(targetDir);
    symlinkSync(targetDir, linkDir);

    const expectedReal = realpathSync(targetDir);
    expect(canonicalRealPath(targetDir)).toBe(expectedReal);
    expect(canonicalRealPath(linkDir)).toBe(expectedReal);
    expect(canonicalRealPath(targetDir, expectedReal.length)).toBe(expectedReal);
    expect(canonicalRealPath(targetDir, expectedReal.length - 1)).toBeNull();
    expect(canonicalRealPath('relative/path')).toBeNull();
    expect(canonicalRealPath(join(base, 'missing-dir'))).toBeNull();
    expect(canonicalRealPath('')).toBeNull();
    expect(canonicalRealPath(null)).toBeNull();
  });

  it('extracts optional booleans without coercing truthy or falsy non-booleans', () => {
    expect(optionalBoolean(true)).toBe(true);
    expect(optionalBoolean(false)).toBe(false);
    expect(optionalBoolean(1)).toBeUndefined();
    expect(optionalBoolean(0)).toBeUndefined();
    expect(optionalBoolean('true')).toBeUndefined();
    expect(optionalBoolean(null)).toBeUndefined();
    expect(optionalBoolean(undefined)).toBeUndefined();
  });
});
