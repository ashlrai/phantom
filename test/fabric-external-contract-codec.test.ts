import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  canonicalJsonBytes,
  canonicalJsonString,
  decodeStrictUtf8JsonBytes,
  deepFreeze,
  exactKeys,
  hmacSha256Hex,
  isCanonicalIsoTimestamp,
  isEnumValue,
  isSafeIntegerInRange,
  isUnsupportedStackSourceVersionV1,
  isValidStackSourceV1,
  sha256Hex,
  sha256Prefixed,
  strictPlainRecord,
  timingSafeUtf8Equal,
} from '../src/core/fabric/external-contract-codec.js';

const BOUNDS = { maxDepth: 4, maxNodes: 32, maxBytes: 256 };
const COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-11-26T00:00:00.000Z');

describe('external-contract-codec', () => {
  it('accepts only plain objects with enumerable string data descriptors', () => {
    expect(strictPlainRecord({ a: 1 })).toEqual({ a: 1 });
    expect(strictPlainRecord(Object.assign(Object.create(null), { a: 1 }))).toEqual({ a: 1 });
    expect(strictPlainRecord(null)).toBeNull();
    expect(strictPlainRecord([])).toBeNull();
    expect(strictPlainRecord(new Date())).toBeNull();
    expect(strictPlainRecord({ get a() { return 1; } })).toBeNull();
    const hidden = {};
    Object.defineProperty(hidden, 'a', { value: 1, enumerable: false });
    expect(strictPlainRecord(hidden)).toBeNull();
    expect(strictPlainRecord({ [Symbol('k')]: 1 })).toBeNull();
    expect(exactKeys({ b: 1, a: 2 }, ['a', 'b'])).toBe(true);
    expect(exactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
  });

  it('canonicalizes bounded JSON values and rejects hostile or oversized inputs', () => {
    expect(canonicalJsonString({ b: -0, a: [1, true, null] })).toBe('{"a":[1,true,null],"b":0}');
    expect(() => canonicalJsonString({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toThrow(TypeError);
    expect(() => canonicalJsonString({ a: 1, b: 2 }, { maxNodes: 2 })).toThrow(TypeError);
    expect(() => canonicalJsonString({ a: Number.NaN })).toThrow(TypeError);
    expect(canonicalJsonBytes({ b: -0, a: [1, true, null] }, BOUNDS)?.toString('utf8'))
      .toBe('{"a":[1,true,null],"b":0}');
    expect(canonicalJsonBytes({ a: Number.NaN }, BOUNDS)).toBeNull();
    const sparse: unknown[] = [];
    sparse[1] = 'x';
    expect(canonicalJsonBytes(sparse, BOUNDS)).toBeNull();
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(canonicalJsonBytes(cycle, BOUNDS)).toBeNull();
    expect(canonicalJsonBytes({ a: { b: { c: { d: { e: 1 } } } } }, BOUNDS)).toBeNull();
    expect(canonicalJsonBytes({ pad: 'x'.repeat(300) }, BOUNDS)).toBeNull();
  });

  it('computes NUL-delimited domain digests and HMACs without double-delimiting', () => {
    const payload = Buffer.from('{"ok":true}', 'utf8');
    const key = Buffer.alloc(32, 7);
    const otherKey = Buffer.alloc(32, 9);
    expect(sha256Hex('ashlr:test:v1', payload)).toBe(sha256Hex('ashlr:test:v1\0', payload));
    expect(sha256Prefixed('ashlr:test:v1', payload)).toBe(`sha256:${sha256Hex('ashlr:test:v1', payload)}`);
    expect(hmacSha256Hex(key, 'ashlr:test:v1', payload)).toBe(hmacSha256Hex(key, 'ashlr:test:v1\0', '{"ok":true}'));
    expect(hmacSha256Hex(key, 'ashlr:test:v1', payload)).not.toBe(hmacSha256Hex(otherKey, 'ashlr:test:v1', payload));
    expect(hmacSha256Hex(key, 'ashlr:test:v1', payload)).not.toBe(hmacSha256Hex(key, 'ashlr:test:v2', payload));
    expect(timingSafeUtf8Equal('abc', 'abc')).toBe(true);
    expect(timingSafeUtf8Equal('abc', 'abd')).toBe(false);
    expect(timingSafeUtf8Equal('abc', 123)).toBe(false);
  });

  it('validates timestamps, ranges, enums, Stack 0.2.x sources, and deep-freezes graphs', () => {
    expect(isCanonicalIsoTimestamp('2026-11-26T00:00:00.000Z', 24)).toBe(true);
    expect(isCanonicalIsoTimestamp('2026-11-26T00:00:00Z', 24)).toBe(false);
    expect(isCanonicalIsoTimestamp('+010000-01-01T00:00:00.000Z', 24)).toBe(false);
    expect(isCanonicalIsoTimestamp('+010000-01-01T00:00:00.000Z')).toBe(true);
    expect(isSafeIntegerInRange(5, 0, 10)).toBe(true);
    expect(isSafeIntegerInRange(1.5, 0, 10)).toBe(false);
    expect(isEnumValue('stack', ['stack', 'locus'] as const)).toBe(true);
    expect(isEnumValue('other', ['stack', 'locus'] as const)).toBe(false);

    expect(isValidStackSourceV1({ product: 'stack', version: '0.2.4', commit: COMMIT })).toBe(true);
    expect(isValidStackSourceV1({ product: 'stack', version: '0.3.0', commit: COMMIT })).toBe(false);
    expect(isUnsupportedStackSourceVersionV1({ product: 'stack', version: '0.3.0', commit: COMMIT })).toBe(true);
    expect(isUnsupportedStackSourceVersionV1({ product: 'stack', version: '0.2.4', commit: COMMIT })).toBe(false);

    const nested = deepFreeze({ child: { value: 1 } });
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested.child)).toBe(true);
  });

  it('decodes strict UTF-8 JSON bytes and classifies size, UTF-8, and parse failures', () => {
    const valid = decodeStrictUtf8JsonBytes(Buffer.from('{"a":1}', 'utf8'), 64, NOW);
    expect(valid).toEqual({ ok: true, copied: Buffer.from('{"a":1}', 'utf8'), parsed: { a: 1 } });
    expect(decodeStrictUtf8JsonBytes('not-bytes', 64, NOW)).toEqual({ ok: false, reason: 'invalid-bytes' });
    expect(decodeStrictUtf8JsonBytes(Buffer.alloc(65, 0x7b), 64, NOW)).toEqual({ ok: false, reason: 'oversized' });
    expect(decodeStrictUtf8JsonBytes(Buffer.from([0xff, 0xfe]), 64, NOW))
      .toEqual({ ok: false, reason: 'invalid-bytes' });
    expect(decodeStrictUtf8JsonBytes(Buffer.from('{bad', 'utf8'), 64, NOW))
      .toEqual({ ok: false, reason: 'non-canonical-json' });
    expect(decodeStrictUtf8JsonBytes(Buffer.from('{}', 'utf8'), 64, new Date(Number.NaN)))
      .toEqual({ ok: false, reason: 'invalid-bytes' });
  });

  it('has no filesystem, process, provider, or network imports or calls', () => {
    const sourcePath = fileURLToPath(new URL('../src/core/fabric/external-contract-codec.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/from ['"]node:(?:fs|http|https|net|tls|child_process|os|worker_threads)['"]/u);
    expect(source).not.toMatch(/\b(?:fetch|WebSocket|XMLHttpRequest|exec|execFile|spawn|fork)\s*\(/u);
    expect(source).not.toMatch(/\bprocess\s*\./u);
    expect(source).not.toMatch(/\b(?:readFile|readdir|stat|access|open|connect|request)Sync\s*\(/u);
  });
});
